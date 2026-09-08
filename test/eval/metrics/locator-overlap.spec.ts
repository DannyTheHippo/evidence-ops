import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chunkOverlapsAnyLocator,
  chunkOverlapsLocator,
  classifyOverlapScoringMethod,
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
    elements: chunk.elements,
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

  describe('retained element locators', () => {
    it("should match a chunk on a later page via its retained elements, even though the chunk's own anchor locator names only the first page", async () => {
      const chunk: OverlapCandidateChunk = {
        filename: 'multi-page.pdf',
        text: 'page one text\n\npage four text',
        locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
        elements: [
          {
            locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
            text: 'page one text',
          },
          {
            locator: { kind: 'pdf-page', page: 4, extractorVersion: 'pdf-pdfjs-1' },
            text: 'page four text',
          },
        ],
      };
      const locator: Locator = { kind: 'pdf-page', file: 'multi-page.pdf', page: 4 };

      expect(await chunkOverlapsLocator(chunk, locator)).toBe(true);
    });

    it('should not match a page the chunk does not actually span', async () => {
      const chunk: OverlapCandidateChunk = {
        filename: 'multi-page.pdf',
        text: 'page one text',
        locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
        elements: [
          {
            locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
            text: 'page one text',
          },
        ],
      };
      const locator: Locator = { kind: 'pdf-page', file: 'multi-page.pdf', page: 9 };

      expect(await chunkOverlapsLocator(chunk, locator)).toBe(false);
    });

    // Regression: a chunk resolved through `RetrievedChunk` carries no retained elements at all —
    // `chunkOverlapsLocator` must still fall back to text-containment overlap for it, unchanged.
    it('should fall back to text-containment overlap when the chunk carries no retained elements', async () => {
      const chunks: OverlapCandidateChunk[] = (await chunksFor('lease-summary.docx')).map(
        (chunk) => ({ filename: chunk.filename, text: chunk.text, locator: chunk.locator }),
      );
      const locator: Locator = {
        kind: 'docx-paragraph',
        file: 'lease-summary.docx',
        paragraphIndex: 3,
        headingPath: ['Lease Abstract — Northgate Business Park', 'Premises'],
      };

      const matches = await Promise.all(
        chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)),
      );

      expect(matches.some(Boolean)).toBe(true);
    });
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

describe('text-block locator scoring', () => {
  it('should match a chunk via retained text-block elements at the matching blockIndex', async () => {
    const chunk: OverlapCandidateChunk = {
      filename: 'filing.htm',
      text: 'block zero\n\nblock one',
      locator: { kind: 'text-block', blockIndex: 0, headingPath: [], extractorVersion: 'v1' },
      elements: [
        {
          locator: { kind: 'text-block', blockIndex: 0, headingPath: [], extractorVersion: 'v1' },
          text: 'block zero',
        },
        {
          locator: { kind: 'text-block', blockIndex: 1, headingPath: [], extractorVersion: 'v1' },
          text: 'block one',
        },
      ],
    };
    const locator: Locator = { kind: 'text-block', file: 'filing.htm', blockIndex: 1 };

    expect(await chunkOverlapsLocator(chunk, locator)).toBe(true);
  });

  it('should not match a text-block at a different blockIndex', async () => {
    const chunk: OverlapCandidateChunk = {
      filename: 'filing.htm',
      text: 'block zero',
      locator: { kind: 'text-block', blockIndex: 0, headingPath: [], extractorVersion: 'v1' },
      elements: [
        {
          locator: { kind: 'text-block', blockIndex: 0, headingPath: [], extractorVersion: 'v1' },
          text: 'block zero',
        },
      ],
    };
    const locator: Locator = { kind: 'text-block', file: 'filing.htm', blockIndex: 9 };

    expect(await chunkOverlapsLocator(chunk, locator)).toBe(false);
  });

  it('should return false for a text-block locator against a chunk of a different locator kind', async () => {
    const chunk: OverlapCandidateChunk = {
      filename: 'filing.htm',
      text: 'page one text',
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
    };
    const locator: Locator = { kind: 'text-block', file: 'filing.htm', blockIndex: 0 };

    expect(await chunkOverlapsLocator(chunk, locator)).toBe(false);
  });

  // Regression: without threading `corpusDir` into `resolveLocatorText`, this would try to read
  // 'sample.htm' from the default fixtures/data-room corpus, where it does not exist, and reject
  // instead of resolving — proving the parameter actually reaches the text-containment fallback.
  it('should fall back to text-containment resolved from an explicit corpusDir', async () => {
    const corpusDir = await mkdtemp(path.join(tmpdir(), 'locator-overlap-'));
    try {
      await writeFile(
        path.join(corpusDir, 'sample.htm'),
        '<html><body><p>Alpha unique marker qwerty123</p></body></html>',
      );
      const chunk: OverlapCandidateChunk = {
        filename: 'sample.htm',
        text: 'Alpha unique marker qwerty123',
        locator: { kind: 'text-block', blockIndex: 0, headingPath: [], extractorVersion: 'v1' },
      };
      const locator: Locator = { kind: 'text-block', file: 'sample.htm', blockIndex: 0 };

      expect(await chunkOverlapsLocator(chunk, locator, corpusDir)).toBe(true);
    } finally {
      await rm(corpusDir, { recursive: true, force: true });
    }
  });
});

describe('classifyOverlapScoringMethod', () => {
  it('should classify a chunk carrying retained elements as element-index', () => {
    const chunk: Pick<OverlapCandidateChunk, 'elements'> = {
      elements: [
        {
          locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
          text: 'page one text',
        },
      ],
    };

    expect(classifyOverlapScoringMethod(chunk)).toBe('element-index');
  });

  it('should classify a chunk with an empty elements array as text-containment', () => {
    expect(classifyOverlapScoringMethod({ elements: [] })).toBe('text-containment');
  });

  // Regression: a chunk resolved through `RetrievedChunk`, or a row ingested before `elements`
  // existed, carries no `elements` field at all — `.lean()` never populates a Mongoose default.
  it('should classify a chunk with no elements field at all as text-containment', () => {
    expect(classifyOverlapScoringMethod({ elements: undefined })).toBe('text-containment');
  });
});
