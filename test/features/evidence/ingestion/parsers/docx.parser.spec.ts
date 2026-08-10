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
    it('should reject an archive whose entry compression ratio indicates a zip bomb', async () => {
      const zip = new JSZip();
      // A 5MB run of a single repeated byte deflates to a few KB (~1000:1) — a cheap, realistic
      // stand-in for a zip-bomb entry, well past the parser's compression-ratio cap.
      zip.file('word/document.xml', 'A'.repeat(5_000_000), {
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    it('should reject an archive entry using a path-traversal name', async () => {
      const zip = new JSZip();
      zip.file('../../etc/evil.xml', '<w:document/>');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
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
