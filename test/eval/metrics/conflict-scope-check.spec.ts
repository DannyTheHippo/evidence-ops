import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { conflictValuesOverlapExpectedLocators } from '../../../eval/metrics/conflict-scope-check';
import {
  chunkOverlapsLocator,
  type OverlapCandidateChunk,
} from '../../../eval/metrics/locator-overlap';
import type { Locator } from '../../../eval/dataset/schema';
import { chunkElements } from '../../../src/features/evidence/ingestion/chunker';
import { PdfParser } from '../../../src/features/evidence/ingestion/parsers/pdf.parser';
import { XlsxParser } from '../../../src/features/evidence/ingestion/parsers/xlsx.parser';

const DATA_ROOM_DIR = path.join(__dirname, '../../../fixtures/data-room');

async function chunksFor(file: string): Promise<OverlapCandidateChunk[]> {
  const content = await readFile(path.join(DATA_ROOM_DIR, file));
  const parser = file.endsWith('.pdf') ? new PdfParser() : new XlsxParser();
  const { elements } = await parser.parse(content);

  return chunkElements(elements).map((chunk) => ({
    filename: file,
    text: chunk.text,
    locator: chunk.locator,
  }));
}

async function firstChunkOverlapping(
  chunks: readonly OverlapCandidateChunk[],
  locator: Locator,
): Promise<OverlapCandidateChunk> {
  const overlaps = await Promise.all(chunks.map((chunk) => chunkOverlapsLocator(chunk, locator)));
  const index = overlaps.indexOf(true);
  if (index === -1) {
    throw new Error('no fixture chunk overlaps the given locator — fixture data changed');
  }
  return chunks[index];
}

describe('conflictValuesOverlapExpectedLocators', () => {
  jest.setTimeout(30_000);

  // con-001's seeded conflict, from `eval/dataset/cases.json`: comps.xlsx!F2 vs. valuation-memo.pdf
  // page 2.
  const expectedLocators: Locator[] = [
    { kind: 'xlsx-cell', file: 'comps.xlsx', sheet: 'Comps', cell: 'F2' },
    { kind: 'pdf-page', file: 'valuation-memo.pdf', page: 2 },
  ];

  it("should return true when every value's source chunk overlaps an expected locator", async () => {
    const compsChunks = await chunksFor('comps.xlsx');
    const memoChunks = await chunksFor('valuation-memo.pdf');
    const compsHit = await firstChunkOverlapping(compsChunks, expectedLocators[0]);
    const memoHit = await firstChunkOverlapping(memoChunks, expectedLocators[1]);
    const chunkById = new Map<string, OverlapCandidateChunk>([
      ['comps-value', compsHit],
      ['memo-value', memoHit],
    ]);

    const result = await conflictValuesOverlapExpectedLocators(
      ['comps-value', 'memo-value'],
      (chunkId) => chunkById.get(chunkId),
      expectedLocators,
    );

    expect(result).toBe(true);
  });

  it("should return false when a value's source chunk belongs to a different property's fact (mis-scoped conflict)", async () => {
    // con-007's fact (Kestrel Point Logistics Center's building area, a real seeded conflict in
    // the fixture corpus) is not con-001's Northgate cap-rate conflict — a conflict attached to
    // the wrong property must fail this check even though a conflict was genuinely surfaced.
    const compsChunks = await chunksFor('comps.xlsx');
    const memoChunks = await chunksFor('valuation-memo.pdf');
    const capRateHit = await firstChunkOverlapping(compsChunks, expectedLocators[0]);
    const wrongFactHit = await firstChunkOverlapping(memoChunks, expectedLocators[1]);
    const kestrelChunks = await chunksFor('kestrel-point-pm-export.xlsx');
    const misScopedHit = await firstChunkOverlapping(kestrelChunks, {
      kind: 'xlsx-cell',
      file: 'kestrel-point-pm-export.xlsx',
      sheet: 'Rent Roll',
      cell: 'B2',
    });
    const chunkById = new Map<string, OverlapCandidateChunk>([
      ['comps-value', capRateHit],
      ['memo-value', wrongFactHit],
      ['mis-scoped-value', misScopedHit],
    ]);

    const result = await conflictValuesOverlapExpectedLocators(
      ['comps-value', 'memo-value', 'mis-scoped-value'],
      (chunkId) => chunkById.get(chunkId),
      expectedLocators,
    );

    expect(result).toBe(false);
  });

  it('should return false when a sourceChunkId cannot be resolved to any retrieved chunk', async () => {
    const result = await conflictValuesOverlapExpectedLocators(
      ['missing-chunk-id'],
      () => undefined,
      expectedLocators,
    );

    expect(result).toBe(false);
  });

  it('should return false when there are no source chunk ids', async () => {
    const result = await conflictValuesOverlapExpectedLocators(
      [],
      () => undefined,
      expectedLocators,
    );

    expect(result).toBe(false);
  });
});
