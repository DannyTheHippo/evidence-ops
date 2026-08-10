/**
 * A deterministic xlsx fact locates to a single cell, but `ExtractedFact.chunkId` must still
 * reference the `EvidenceChunk` (an `xlsx-region` window of several rows) ingestion already
 * persisted for that cell — the "own copy of the locator" case the schema comment on
 * `ExtractedFact.locator` names explicitly: a fact pinning a narrower position than the chunk it
 * came from. This resolves that chunk by checking which persisted region's row range contains
 * the fact's row, on the same sheet.
 */
interface XlsxRegionChunkLike {
  readonly locator: unknown;
}

// Exported for `facts.service.ts`, which needs the same row-of-a-cell-address extraction to look
// up a fact's containing chunk — throwing on a malformed address (rather than returning
// `undefined`) is deliberate: every cell address here originates from `XlsxParser`, which always
// emits well-formed A1 notation, so a mismatch is a real invariant violation worth failing loud on
// instead of silently producing `NaN`.
export function parseRowFromCellAddress(cellAddress: string): number {
  const match = /(\d+)$/.exec(cellAddress);
  if (!match) {
    throw new Error(`Cell address '${cellAddress}' is not in A1 notation`);
  }
  return Number(match[1]);
}

export function findXlsxRegionChunk<TChunk extends XlsxRegionChunkLike>(
  chunks: readonly TChunk[],
  sheetName: string,
  row: number,
): TChunk | undefined {
  return chunks.find((chunk) => {
    const locator = chunk.locator as { kind?: string; sheetName?: string; range?: string };
    if (locator.kind !== 'xlsx-region' || locator.sheetName !== sheetName || !locator.range) {
      return false;
    }
    const [start, end] = locator.range.split(':');
    const startRow = parseRowFromCellAddress(start);
    const endRow = parseRowFromCellAddress(end);
    return row >= startRow && row <= endRow;
  });
}
