import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { DocxParagraphLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  DocxParser,
  MalformedDocxException,
} from '../../../../../src/features/evidence/ingestion/parsers/docx.parser';
import { HostileArchiveException } from '../../../../../src/features/evidence/ingestion/parsers/safe-zip';
import manifest from '../../../../../fixtures/data-room/manifest.json';

const FIXTURE_PATH = path.join(__dirname, '../../../../../fixtures/data-room/lease-summary.docx');
const MANIFEST_PARAGRAPHS = manifest.files['lease-summary.docx'].paragraphs;

const CENTRAL_DIRECTORY_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const CENTRAL_DIRECTORY_UNCOMPRESSED_SIZE_OFFSET = 24;
const CENTRAL_DIRECTORY_FILE_NAME_LENGTH_OFFSET = 28;
const CENTRAL_DIRECTORY_FIXED_LENGTH = 46;

/**
 * Overwrites the declared uncompressed-size field in `buffer`'s central-directory record for
 * `entryName`, leaving the compressed payload and every other byte untouched. Simulates the one
 * thing `assertSafeArchive` cannot see through: a central directory that under-reports what an
 * entry actually inflates to. JSZip reads an entry's real compressed bytes off the (unpatched)
 * local file header using the central directory's compressed-size field, so the entry still
 * decompresses to its true, larger content.
 */
function lieAboutDeclaredUncompressedSize(
  buffer: Buffer,
  entryName: string,
  liedUncompressedSize: number,
): Buffer {
  const nameBytes = Buffer.from(entryName, 'utf8');
  const patched = Buffer.from(buffer);

  let recordStart = patched.indexOf(CENTRAL_DIRECTORY_SIGNATURE);
  while (recordStart !== -1) {
    const fileNameLength = patched.readUInt16LE(
      recordStart + CENTRAL_DIRECTORY_FILE_NAME_LENGTH_OFFSET,
    );
    const nameStart = recordStart + CENTRAL_DIRECTORY_FIXED_LENGTH;
    const recordName = patched.subarray(nameStart, nameStart + fileNameLength);
    if (recordName.equals(nameBytes)) {
      patched.writeUInt32LE(
        liedUncompressedSize,
        recordStart + CENTRAL_DIRECTORY_UNCOMPRESSED_SIZE_OFFSET,
      );
      return patched;
    }
    recordStart = patched.indexOf(CENTRAL_DIRECTORY_SIGNATURE, recordStart + 4);
  }
  throw new Error(`Fixture has no central-directory record for "${entryName}"`);
}

describe('DocxParser', () => {
  let parser: DocxParser;

  beforeEach(() => {
    parser = new DocxParser();
  });

  describe('parse — lease-summary.docx fixture', () => {
    it('should produce one element per manifest paragraph, with matching text and in document order', async () => {
      const content = await readFile(FIXTURE_PATH);

      const result = await parser.parse(content);

      expect(result.elements).toHaveLength(MANIFEST_PARAGRAPHS.length);
      result.elements.forEach((element, index) => {
        expect(element.text).toBe(MANIFEST_PARAGRAPHS[index].text);
      });
    });

    it("should stamp paragraphIndex zero-based, matching each element's position", async () => {
      const content = await readFile(FIXTURE_PATH);

      const result = await parser.parse(content);

      expect(MANIFEST_PARAGRAPHS[0].index).toBe(0);
      result.elements.forEach((element, index) => {
        const locator = element.locator as DocxParagraphLocator;
        expect(locator.kind).toBe('docx-paragraph');
        expect(locator.paragraphIndex).toBe(index);
      });
    });

    it('should carry the manifest heading path for a paragraph nested under a known heading', async () => {
      const content = await readFile(FIXTURE_PATH);
      const headingIndex = MANIFEST_PARAGRAPHS.findIndex(
        (paragraph) => paragraph.style === 'Heading2' && paragraph.text === 'Term',
      );
      const nestedIndex = headingIndex + 1;
      expect(MANIFEST_PARAGRAPHS[headingIndex].style).toBe('Heading2');
      expect(MANIFEST_PARAGRAPHS[nestedIndex].style).toBe('Normal');

      const result = await parser.parse(content);

      const headingElement = result.elements[headingIndex];
      const nestedElement = result.elements[nestedIndex];
      expect(headingElement.headingPath).toEqual(MANIFEST_PARAGRAPHS[headingIndex].headingPath);
      expect(nestedElement.headingPath).toEqual(MANIFEST_PARAGRAPHS[nestedIndex].headingPath);
      expect((nestedElement.locator as DocxParagraphLocator).headingPath).toEqual(
        MANIFEST_PARAGRAPHS[nestedIndex].headingPath,
      );
    });

    it('should reset the heading trail to the new level when a sibling Heading2 starts', async () => {
      const content = await readFile(FIXTURE_PATH);
      const result = await parser.parse(content);

      const headingIndexes = MANIFEST_PARAGRAPHS.reduce<number[]>((acc, paragraph, index) => {
        if (paragraph.style === 'Heading2') {
          acc.push(index);
        }
        return acc;
      }, []);

      // Every Heading2 paragraph's own heading path must end in its own text, not a prior
      // sibling's — proves the trail is replaced at its level rather than accumulated.
      for (const index of headingIndexes) {
        expect(result.elements[index].headingPath.at(-1)).toBe(MANIFEST_PARAGRAPHS[index].text);
      }
    });

    it('should stamp extractorVersion on the document and on every locator', async () => {
      const content = await readFile(FIXTURE_PATH);

      const result = await parser.parse(content);

      expect(result.extractorVersion).toBe('docx-ooxml-1');
      expect(result.elements.length).toBeGreaterThan(0);
      for (const element of result.elements) {
        expect(element.locator.extractorVersion).toBe('docx-ooxml-1');
      }
    });
  });

  describe('parse — hostile archives (fails closed)', () => {
    /**
     * A high compression ratio is a property of repetitive text, not of an attack: a document of
     * repeated boilerplate genuinely deflates several hundred to one. The parse must turn on the
     * bytes the entry really inflates to, which this one keeps well inside the budget.
     */
    it('should parse a document whose repetitive text compresses far past a hundred to one', async () => {
      const paragraphs = '<w:p><w:r><w:t>Base Rent</w:t></w:r></w:p>'.repeat(20_000);
      const zip = new JSZip();
      zip.file(
        'word/document.xml',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:body>${paragraphs}</w:body></w:document>`,
        { compression: 'DEFLATE', compressionOptions: { level: 9 } },
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const reloaded = await JSZip.loadAsync(buffer);
      const sizes = (
        reloaded.files['word/document.xml'] as unknown as {
          _data: { compressedSize: number; uncompressedSize: number };
        }
      )._data;

      const result = await parser.parse(buffer);

      expect(sizes.uncompressedSize / sizes.compressedSize).toBeGreaterThan(100);
      expect(result.elements).toHaveLength(20_000);
      expect(result.elements[0].text).toBe('Base Rent');
    });

    it('should reject an archive entry using a path-traversal name', async () => {
      const zip = new JSZip();
      zip.file('../../etc/evil.xml', '<w:document/>');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    it('should reject an entry whose real inflated bytes exceed the archive budget even though its declared size passes assertSafeArchive', async () => {
      const zip = new JSZip();
      zip.file('word/document.xml', 'A'.repeat(8_500_000), {
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      // The central directory now declares 1024 uncompressed bytes for an entry that really
      // inflates to 8.5MB — a mismatch assertSafeArchive's declared-size checks cannot detect,
      // since they only ever read what the archive itself claims.
      const hostileBuffer = lieAboutDeclaredUncompressedSize(buffer, 'word/document.xml', 1024);

      await expect(parser.parse(hostileBuffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    it('should reject a document.xml that declares a DOCTYPE', async () => {
      const zip = new JSZip();
      zip.file(
        'word/document.xml',
        '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document/>',
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });
  });

  describe('parse — heading style edge cases', () => {
    it('should parse a paragraph styled Heading0 as a plain paragraph rather than throwing', async () => {
      // Regression: `Heading0` matches `HEADING_STYLE_PATTERN` and yields `level = 0`, which used
      // to feed `headingTrail.length = Math.min(headingTrail.length, level - 1)` — `Math.min(n,
      // -1)` is `-1`, and assigning a negative `.length` throws a native `RangeError`.
      const zip = new JSZip();
      zip.file(
        'word/document.xml',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:pPr><w:pStyle w:val="Heading0"/></w:pPr>' +
          '<w:r><w:t>Not a real heading</w:t></w:r></w:p></w:body></w:document>',
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(buffer);

      expect(result.elements).toHaveLength(1);
      expect(result.elements[0].text).toBe('Not a real heading');
      expect(result.elements[0].headingPath).toEqual([]);
    });
  });

  describe('parse — malformed input', () => {
    it('should reject an archive missing word/document.xml', async () => {
      const zip = new JSZip();
      zip.file('README.txt', 'not a docx');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedDocxException);
    });

    it('should reject a buffer that is not a zip archive at all', async () => {
      await expect(parser.parse(Buffer.from('not a zip'))).rejects.toBeInstanceOf(
        MalformedDocxException,
      );
    });
  });
});
