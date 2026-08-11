import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  chunkOverlapsAnyLocator,
  chunkOverlapsLocator,
  type OverlapCandidateChunk,
} from '../../../eval/metrics/locator-overlap';
import type { Locator } from '../../../eval/dataset/schema';
import { chunkElements } from '../../../src/features/evidence/ingestion/chunker';
import { DocxParser } from '../../../src/features/evidence/ingestion/parsers/docx.parser';
import { PdfParser } from '../../../src/features/evidence/ingestion/parsers/pdf.parser';
import { XlsxParser } from '../../../src/features/evidence/ingestion/parsers/xlsx.parser';

const DATA_ROOM_DIR = path.join(__dirname, '../../../fixtures/data-room');

async function chunksFor(file: string): Promise<OverlapCandidateChunk[]> {
  const content = await readFile(path.join(DATA_ROOM_DIR, file));
  const parser = file.endsWith('.pdf')
    ? new PdfParser()
    : file.endsWith('.docx')
      ? new DocxParser()
      : new XlsxParser();
  const { elements } = await parser.parse(content);

  return chunkElements(elements).map((chunk) => ({
    filename: file,
    text: chunk.text,
    locator: chunk.locator,
  }));
}

describe('chunkOverlapsLocator', () => {
  jest.setTimeout(30_000);

  it('should match a chunk whose xlsx-region range contains the dataset cell', async () => {
    const chunks = await chunksFor('comps.xlsx');
    const locator: Locator = { kind: 'xlsx-cell', file: 'comps.xlsx', sheet: 'Comps', cell: 'E4' };

    const matches = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));

    expect(matches.some(Boolean)).toBe(true);
  });

  it('should match every row-window chunk a multi-row locator range straddles, not only the first', async () => {
    // comps.xlsx has 10 data rows (manifest usedRange 'A1:H11') and `chunkSheet` closes a window
    // every 4 rows (`SHEET_ROWS_PER_WINDOW`), so rows 2-5/6-9/10-11 become three non-overlapping
    // windows. A locator spanning rows 4-7 straddles the row-5/row-6 window boundary and must
    // overlap both the row-2..5 window and the row-6..9 window — a single point-in-range
    // containment check against only the locator's start cell would silently report just one.
    const chunks = await chunksFor('comps.xlsx');
    const locator: Locator = {
      kind: 'xlsx-cell',
      file: 'comps.xlsx',
      sheet: 'Comps',
      cell: 'E4:E7',
    };

    const matches = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));

    expect(matches.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it('should not match an xlsx chunk from a different sheet', async () => {
    const chunks = await chunksFor('comps.xlsx');
    const locator: Locator = {
      kind: 'xlsx-cell',
      file: 'comps.xlsx',
      sheet: 'NotASheet',
      cell: 'E4',
    };

    const matches = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));

    expect(matches.some(Boolean)).toBe(false);
  });

  it('should match a chunk whose text contains the target docx paragraph', async () => {
    const chunks = await chunksFor('lease-summary.docx');
    const locator: Locator = {
      kind: 'docx-paragraph',
      file: 'lease-summary.docx',
      paragraphIndex: 3,
      headingPath: ['Lease Abstract — Northgate Business Park', 'Premises'],
    };

    const matches = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));

    expect(matches.some(Boolean)).toBe(true);
  });

  it('should match a chunk whose text contains the target pdf page', async () => {
    const chunks = await chunksFor('valuation-memo.pdf');
    const locator: Locator = { kind: 'pdf-page', file: 'valuation-memo.pdf', page: 3 };

    const matches = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));

    expect(matches.some(Boolean)).toBe(true);
  });

  it('should never match when the filename differs, regardless of locator kind', async () => {
    const chunks = await chunksFor('comps.xlsx');
    const locator: Locator = {
      kind: 'xlsx-cell',
      file: 'a-different-file.xlsx',
      sheet: 'Comps',
      cell: 'E4',
    };

    const matches = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));

    expect(matches.some(Boolean)).toBe(false);
  });

  it("should return false for a locator kind that cannot exist on the chunk's file (defensive)", async () => {
    const chunks = await chunksFor('comps.xlsx');
    const locator: Locator = { kind: 'pdf-page', file: 'comps.xlsx', page: 1 };

    const matches = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));

    expect(matches.some(Boolean)).toBe(false);
  });
});

describe('chunkOverlapsAnyLocator', () => {
  it('should return true when the chunk overlaps at least one of several locators', async () => {
    const chunks = await chunksFor('comps.xlsx');
    const locators: Locator[] = [
      { kind: 'xlsx-cell', file: 'comps.xlsx', sheet: 'Comps', cell: 'E4' },
      { kind: 'pdf-page', file: 'valuation-memo.pdf', page: 3 },
    ];

    const results = await Promise.all(
      chunks.map((chunk) => chunkOverlapsAnyLocator(chunk, locators)),
    );

    expect(results.some(Boolean)).toBe(true);
  });

  it('should return false when the chunk overlaps none of the locators', async () => {
    const chunks = await chunksFor('comps.xlsx');
    const locators: Locator[] = [{ kind: 'pdf-page', file: 'valuation-memo.pdf', page: 3 }];

    const results = await Promise.all(
      chunks.map((chunk) => chunkOverlapsAnyLocator(chunk, locators)),
    );

    expect(results.some(Boolean)).toBe(false);
  });
});
