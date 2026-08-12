import JSZip from 'jszip';
import type { PptxSlideLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { MalformedPptxException } from '../../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import { PptxParser } from '../../../../../src/features/evidence/ingestion/parsers/pptx.parser';
import { HostileArchiveException } from '../../../../../src/features/evidence/ingestion/parsers/safe-zip';

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
    it('should reject an archive whose entry compression ratio indicates a zip bomb', async () => {
      const zip = new JSZip();
      // A 5MB run of a single repeated byte deflates to a few KB (~1000:1) — a cheap, realistic
      // stand-in for a zip-bomb entry, well past the parser's compression-ratio cap.
      zip.file('ppt/presentation.xml', 'A'.repeat(5_000_000), {
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
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
