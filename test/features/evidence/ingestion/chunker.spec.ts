import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DocxParagraphLocator,
  PdfPageLocator,
  XlsxRegionLocator,
} from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { chunkElements } from '../../../../src/features/evidence/ingestion/chunker';
import { DocxParser } from '../../../../src/features/evidence/ingestion/parsers/docx.parser';
import type { ParsedElement } from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { XlsxParser } from '../../../../src/features/evidence/ingestion/parsers/xlsx.parser';
import manifest from '../../../../fixtures/data-room/manifest.json';

const DOCX_FIXTURE_PATH = path.join(__dirname, '../../../../fixtures/data-room/lease-summary.docx');
const XLSX_FIXTURE_PATH = path.join(__dirname, '../../../../fixtures/data-room/comps.xlsx');

function pdfElement(
  page: number,
  text: string,
  overrides: Partial<ParsedElement> = {},
): ParsedElement {
  const locator: PdfPageLocator = {
    kind: 'pdf-page',
    page,
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    extractorVersion: 'pdf-pdfjs-1',
  };
  return { text, locator, headingPath: [], ...overrides };
}

function docxElement(
  paragraphIndex: number,
  text: string,
  headingPath: readonly string[],
): ParsedElement {
  const locator: DocxParagraphLocator = {
    kind: 'docx-paragraph',
    paragraphIndex,
    headingPath: [...headingPath],
    extractorVersion: 'docx-ooxml-1',
  };
  return { text, locator, headingPath };
}

function xlsxCellElement(sheetName: string, cell: string, text: string): ParsedElement {
  return {
    text,
    locator: { kind: 'xlsx-cell', sheetName, cell, extractorVersion: 'xlsx-exceljs-1' },
    headingPath: [],
  };
}

describe('chunkElements', () => {
  it('should return no chunks for an empty element list', () => {
    expect(chunkElements([])).toEqual([]);
  });

  describe('prose — heading boundaries', () => {
    it('should never merge two elements from different heading paths into one chunk, even when both are tiny', () => {
      const elements = [
        docxElement(0, 'Section one body.', ['Section 1']),
        docxElement(1, 'Section two body.', ['Section 2']),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe('Section one body.');
      expect(chunks[1].text).toBe('Section two body.');
      expect((chunks[0].locator as DocxParagraphLocator).headingPath).toEqual(['Section 1']);
      expect((chunks[1].locator as DocxParagraphLocator).headingPath).toEqual(['Section 2']);
    });

    it('should merge consecutive elements sharing one heading path into a single chunk', () => {
      const elements = [
        docxElement(0, 'First paragraph.', ['Intro']),
        docxElement(1, 'Second paragraph.', ['Intro']),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('First paragraph.\n\nSecond paragraph.');
      // Anchored to the first spanned element — the locator type has no field for a range.
      expect((chunks[0].locator as DocxParagraphLocator).paragraphIndex).toBe(0);
    });
  });

  describe('prose — overlap', () => {
    it('should carry a tail of the closing chunk into the next chunk of the same run, and never into a chunk across a heading boundary', () => {
      // Long enough on its own, and long enough combined with a second element, to force the
      // window to close after the first element (chars/4 approximation, see chunker.ts).
      const elementAText = `${'filler '.repeat(286)}UNIQUETAILWORD`;
      const elementBText = `${'filler '.repeat(286)}UNIQUEHEADWORD`;
      const elements = [pdfElement(1, elementAText), pdfElement(2, elementBText)];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).not.toContain('UNIQUEHEADWORD');
      expect(chunks[1].text).toContain('UNIQUETAILWORD');
      expect(chunks[1].text).toContain('UNIQUEHEADWORD');
    });

    it('should not leak an in-run overlap tail into the first chunk of the next heading run', () => {
      const elementAText = `${'filler '.repeat(286)}TAILOFONE`;
      const elementBText = `${'filler '.repeat(286)}HEADOFTWO`;
      const elements = [
        // Same heading path, oversized together — forces a 2-chunk run whose second chunk
        // carries an overlap tail from the first.
        docxElement(0, elementAText, ['Section 1']),
        docxElement(1, elementBText, ['Section 1']),
        // A new heading path starts a fresh run; its chunk must not inherit that overlap.
        docxElement(2, 'short body', ['Section 2']),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(3);
      expect(chunks[1].text).toContain('TAILOFONE');
      expect(chunks[2].text).toBe('short body');
      expect(chunks[2].text).not.toContain('TAILOFONE');
      expect(chunks[2].text).not.toContain('HEADOFTWO');
    });
  });

  describe('prose — locators', () => {
    it('should keep a single-element chunk locator identical to its source element', () => {
      const elements = [pdfElement(3, 'short page text')];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].locator).toEqual(elements[0].locator);
    });

    it('should drop boundingBox from a PDF locator once the chunk spans more than one page', () => {
      const elements = [pdfElement(1, 'page one text'), pdfElement(2, 'page two text')];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      const locator = chunks[0].locator as PdfPageLocator;
      expect(locator.kind).toBe('pdf-page');
      expect(locator.page).toBe(1);
      expect(locator.boundingBox).toBeUndefined();
    });
  });

  describe('prose — lease-summary.docx fixture (manifest-driven)', () => {
    it('should chunk exactly on the manifest heading-path runs, anchored to each run’s first paragraph', async () => {
      const content = await readFile(DOCX_FIXTURE_PATH);
      const parsed = await new DocxParser().parse(content);
      const paragraphs = manifest.files['lease-summary.docx'].paragraphs;

      // Independently derive expected run boundaries from the manifest, rather than from the
      // chunker's own grouping — otherwise the test would just restate the implementation.
      const expectedRuns: { startIndex: number; headingPath: readonly string[] }[] = [];
      let previousKey: string | undefined;
      paragraphs.forEach((paragraph, index) => {
        const key = JSON.stringify(paragraph.headingPath);
        if (key !== previousKey) {
          expectedRuns.push({ startIndex: index, headingPath: paragraph.headingPath });
          previousKey = key;
        }
      });

      const chunks = chunkElements(parsed.elements);

      expect(chunks).toHaveLength(expectedRuns.length);
      chunks.forEach((chunk, index) => {
        const locator = chunk.locator as DocxParagraphLocator;
        expect(locator.kind).toBe('docx-paragraph');
        expect(locator.paragraphIndex).toBe(expectedRuns[index].startIndex);
        expect(locator.headingPath).toEqual(expectedRuns[index].headingPath);
      });
    });
  });

  describe('spreadsheet — header repetition and windowing', () => {
    it('should repeat the header row in every window once row content forces more than one window', () => {
      const bigCell = 'x'.repeat(800);
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Col1'),
        xlsxCellElement('Sheet1', 'B1', 'Col2'),
        xlsxCellElement('Sheet1', 'A2', bigCell),
        xlsxCellElement('Sheet1', 'B2', bigCell),
        xlsxCellElement('Sheet1', 'A3', bigCell),
        xlsxCellElement('Sheet1', 'B3', bigCell),
        xlsxCellElement('Sheet1', 'A4', bigCell),
        xlsxCellElement('Sheet1', 'B4', bigCell),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(3);
      const ranges = chunks.map((chunk) => (chunk.locator as XlsxRegionLocator).range);
      expect(ranges).toEqual(['A1:B2', 'A1:B3', 'A1:B4']);
      for (const chunk of chunks) {
        expect(chunk.text).toContain('| Col1 | Col2 |');
        expect(chunk.text).toContain('| --- | --- |');
        expect((chunk.locator as XlsxRegionLocator).sheetName).toBe('Sheet1');
      }
    });

    it('should fill missing cells in a data row as blank markdown columns', () => {
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Col1'),
        xlsxCellElement('Sheet1', 'B1', 'Col2'),
        xlsxCellElement('Sheet1', 'A2', 'only-a'),
        // B2 intentionally absent — mirrors the parser skipping a blank cell.
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('| only-a |  |');
    });
  });

  describe('spreadsheet — comps.xlsx fixture (manifest-driven)', () => {
    it('should serialize the manifest header row into every chunk and keep ranges within the manifest usedRange', async () => {
      const content = await readFile(XLSX_FIXTURE_PATH);
      const parsed = await new XlsxParser().parse(content);
      const sheet = manifest.files['comps.xlsx'].sheets[0];

      const chunks = chunkElements(parsed.elements);

      expect(chunks.length).toBeGreaterThan(0);
      const headerLine = `| ${sheet.headerRow.join(' | ')} |`;
      for (const chunk of chunks) {
        expect(chunk.text).toContain(headerLine);
        const locator = chunk.locator as XlsxRegionLocator;
        expect(locator.kind).toBe('xlsx-region');
        expect(locator.sheetName).toBe(sheet.name);
        // usedRange is 'A1:H11' — every chunk's range must stay within those bounds.
        const [, endCell] = locator.range.split(':');
        const endRow = Number(/\d+$/.exec(endCell)?.[0]);
        expect(endRow).toBeLessThanOrEqual(11);
      }
    });
  });
});
