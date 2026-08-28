import JSZip from 'jszip';
import type { PptxSlideLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { MalformedPptxException } from '../../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import { PptxParser } from '../../../../../src/features/evidence/ingestion/parsers/pptx.parser';
import { HostileArchiveException } from '../../../../../src/features/evidence/ingestion/parsers/safe-zip';

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
 * decompresses to its true, larger content. Mirrors `docx.parser.spec.ts`'s identically-named
 * helper — duplicated by design, the same as this module's other archive-specific test fixtures.
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

// Local, in-test OOXML builders — no binary fixture. Every helper emits the smallest slice of
// the real schema the parser reads, so a test failure points at the parser logic, not at fixture
// drift.

function presentationXml(sldIds: Array<{ id: number; rId: string }>): string {
  const entries = sldIds.map(({ id, rId }) => `<p:sldId id="${id}" r:id="${rId}"/>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<p:sldIdLst>${entries}</p:sldIdLst></p:presentation>`
  );
}

function relsXml(
  relationships: Array<{ id: string; target: string; relationshipType?: string }>,
): string {
  const entries = relationships
    .map(
      ({ id, target, relationshipType }) =>
        `<Relationship Id="${id}" Type="${relationshipType ?? 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'}" Target="${target}"/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `${entries}</Relationships>`
  );
}

function slideXml(spTreeBody: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    `<p:cSld><p:spTree>${spTreeBody}</p:spTree></p:cSld></p:sld>`
  );
}

function textBoxXml(paragraphTexts: string[]): string {
  const paragraphs = paragraphTexts.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`);
  return `<p:sp><p:txBody>${paragraphs.join('')}</p:txBody></p:sp>`;
}

function tableXml(rows: string[][]): string {
  const rowsXml = rows.map(
    (cells) =>
      `<a:tr>${cells
        .map((cell) => `<a:tc><a:txBody><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`)
        .join('')}</a:tr>`,
  );
  return `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rowsXml.join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

describe('PptxParser', () => {
  let parser: PptxParser;

  beforeEach(() => {
    parser = new PptxParser();
  });

  describe('parse — slide ordering and content', () => {
    it('should resolve slide order from sldIdLst, never from slide part filenames', async () => {
      // The slide *parts* are named out of presentation order on purpose (part "slide3.xml"
      // is presented first) — if the parser ever regresses to sorting by filename, this is the
      // test that must fail.
      const zip = new JSZip();
      zip.file(
        'ppt/presentation.xml',
        presentationXml([
          { id: 256, rId: 'rId1' },
          { id: 257, rId: 'rId2' },
          { id: 258, rId: 'rId3' },
        ]),
      );
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([
          { id: 'rId1', target: 'slides/slide3.xml' },
          { id: 'rId2', target: 'slides/slide1.xml' },
          { id: 'rId3', target: 'slides/slide2.xml' },
        ]),
      );
      zip.file('ppt/slides/slide3.xml', slideXml(textBoxXml(['First'])));
      zip.file('ppt/slides/slide1.xml', slideXml(textBoxXml(['Second'])));
      zip.file('ppt/slides/slide2.xml', slideXml(textBoxXml(['Third'])));
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(buffer);

      expect(result.elements).toHaveLength(3);
      expect(result.elements[0].text).toBe('First');
      expect(result.elements[1].text).toBe('Second');
      expect(result.elements[2].text).toBe('Third');
      expect(result.elements[0].locator).toEqual<PptxSlideLocator>({
        kind: 'pptx-slide',
        slide: 1,
        extractorVersion: 'pptx-ooxml-1',
      });
      expect(result.elements[1].locator).toEqual<PptxSlideLocator>({
        kind: 'pptx-slide',
        slide: 2,
        extractorVersion: 'pptx-ooxml-1',
      });
      expect(result.elements[2].locator).toEqual<PptxSlideLocator>({
        kind: 'pptx-slide',
        slide: 3,
        extractorVersion: 'pptx-ooxml-1',
      });
    });

    it("should collect a table's cell text as part of the slide text, in document order", async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentationXml([{ id: 256, rId: 'rId1' }]));
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      );
      zip.file(
        'ppt/slides/slide1.xml',
        slideXml(
          textBoxXml(['Quarterly Results']) +
            tableXml([
              ['Region', 'Revenue'],
              ['North', '100'],
            ]),
        ),
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(buffer);

      expect(result.elements).toHaveLength(1);
      expect(result.elements[0].text).toBe('Quarterly Results\nRegion\nRevenue\nNorth\n100');
      expect(result.elements[0].headingPath).toEqual([]);
    });

    it('should produce an element with empty text for a slide with no text runs, without skipping its slide number', async () => {
      const zip = new JSZip();
      zip.file(
        'ppt/presentation.xml',
        presentationXml([
          { id: 256, rId: 'rId1' },
          { id: 257, rId: 'rId2' },
        ]),
      );
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([
          { id: 'rId1', target: 'slides/slide1.xml' },
          { id: 'rId2', target: 'slides/slide2.xml' },
        ]),
      );
      zip.file('ppt/slides/slide1.xml', slideXml(textBoxXml(['Cover'])));
      zip.file('ppt/slides/slide2.xml', slideXml(''));
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(buffer);

      expect(result.elements).toHaveLength(2);
      expect(result.elements[1].text).toBe('');
      expect(result.elements[1].locator).toEqual<PptxSlideLocator>({
        kind: 'pptx-slide',
        slide: 2,
        extractorVersion: 'pptx-ooxml-1',
      });
    });

    it('should exclude notes slide text from every parsed element', async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentationXml([{ id: 256, rId: 'rId1' }]));
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      );
      zip.file('ppt/slides/slide1.xml', slideXml(textBoxXml(['Visible slide text'])));
      // A notes part exists and is linked from the slide's own rels — a real deck always has
      // this shape — but it is never referenced by sldIdLst, so the parser never visits it.
      zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        relsXml([
          {
            id: 'rId1',
            target: '../notesSlides/notesSlide1.xml',
            relationshipType:
              'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
          },
        ]),
      );
      zip.file(
        'ppt/notesSlides/notesSlide1.xml',
        slideXml(textBoxXml(['Presenter-only speaker notes'])),
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(buffer);

      expect(result.elements).toHaveLength(1);
      expect(result.elements[0].text).toBe('Visible slide text');
      expect(result.elements.some((element) => element.text.includes('speaker notes'))).toBe(false);
    });

    it('should stamp extractorVersion on the document and on every locator', async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentationXml([{ id: 256, rId: 'rId1' }]));
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      );
      zip.file('ppt/slides/slide1.xml', slideXml(textBoxXml(['Text'])));
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(buffer);

      expect(result.extractorVersion).toBe('pptx-ooxml-1');
      for (const element of result.elements) {
        expect(element.locator.extractorVersion).toBe('pptx-ooxml-1');
      }
    });
  });

  describe('parse — hostile archives (fails closed)', () => {
    /**
     * A high compression ratio is a property of repetitive text, not of an attack: a deck of
     * repeated boilerplate genuinely deflates several hundred to one. The parse must turn on the
     * bytes the entry really inflates to, which this one keeps well inside the budget.
     */
    it('should parse a slide whose repetitive text compresses far past a hundred to one', async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentationXml([{ id: 256, rId: 'rId1' }]));
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      );
      zip.file(
        'ppt/slides/slide1.xml',
        slideXml(textBoxXml(Array.from({ length: 20_000 }, () => 'Base Rent'))),
        { compression: 'DEFLATE', compressionOptions: { level: 9 } },
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const reloaded = await JSZip.loadAsync(buffer);
      const sizes = (
        reloaded.files['ppt/slides/slide1.xml'] as unknown as {
          _data: { compressedSize: number; uncompressedSize: number };
        }
      )._data;

      const result = await parser.parse(buffer);

      expect(sizes.uncompressedSize / sizes.compressedSize).toBeGreaterThan(100);
      expect(result.elements.length).toBeGreaterThan(0);
      expect(result.elements[0].text).toContain('Base Rent');
    });

    /**
     * The signal the ratio check never carried: an entry whose central directory under-reports
     * what it really inflates to. Only the real byte count out of the inflater sees it, and that
     * contradiction is what the hostile class is for.
     */
    it('should reject an entry whose real inflated bytes exceed the budget its declared size passed', async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentationXml([{ id: 256, rId: 'rId1' }]));
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      );
      zip.file('ppt/slides/slide1.xml', slideXml(textBoxXml([`${'A'.repeat(8_500_000)}`])), {
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const lyingBuffer = lieAboutDeclaredUncompressedSize(buffer, 'ppt/slides/slide1.xml', 1024);

      await expect(parser.parse(lyingBuffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    it('should reject an archive entry using a path-traversal name', async () => {
      const zip = new JSZip();
      zip.file('../../etc/evil.xml', '<p:presentation/>');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    it('should reject a presentation.xml that declares a DOCTYPE', async () => {
      const zip = new JSZip();
      zip.file(
        'ppt/presentation.xml',
        '<?xml version="1.0"?><!DOCTYPE p:presentation [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><p:presentation/>',
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    it('should reject a slide part that declares a DOCTYPE', async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentationXml([{ id: 256, rId: 'rId1' }]));
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        relsXml([{ id: 'rId1', target: 'slides/slide1.xml' }]),
      );
      zip.file(
        'ppt/slides/slide1.xml',
        '<?xml version="1.0"?><!DOCTYPE p:sld [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><p:sld/>',
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });
  });

  describe('parse — malformed input', () => {
    it('should reject an archive missing ppt/presentation.xml', async () => {
      const zip = new JSZip();
      zip.file('README.txt', 'not a pptx');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedPptxException);
    });

    it('should reject a buffer that is not a zip archive at all', async () => {
      await expect(parser.parse(Buffer.from('not a zip'))).rejects.toBeInstanceOf(
        MalformedPptxException,
      );
    });

    it('should reject a sldIdLst entry whose r:id has no matching relationship', async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentationXml([{ id: 256, rId: 'rId1' }]));
      zip.file('ppt/_rels/presentation.xml.rels', relsXml([]));
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedPptxException);
    });
  });
});
