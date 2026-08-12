export interface HeaderDetectionCell {
  readonly row: number;
  readonly text: string;
}

// Real spreadsheets are not clean grids: a report-layout sheet often has a title (or a merged
// banner) sitting above the actual table. Scanning further than this risks a huge sheet's
// coincidental later run of duplicate-ish values reading as a header; this is a heuristic over the
// sheet's opening rows, not an audit of the whole thing.
const MAX_SCANNED_ROWS = 10;

/**
 * Finds the header row of one sheet's occupied cells.
 *
 * Scans occupied rows ascending, bounded to the first `MAX_SCANNED_ROWS` occupied rows. The header
 * is the first row with at least 2 non-empty cells, at least 2 DISTINCT cell values, and at least
 * one occupied row after it. No match falls back to the topmost occupied row — today's behaviour
 * before this heuristic existed.
 *
 * The distinct-values condition is what makes this compose with `xlsx.parser.ts`'s merged-cell
 * propagation: a merged title propagated across eight columns produces eight non-empty cells but
 * only ONE distinct value, so it is correctly not mistaken for a header row.
 *
 * Failure direction: this is a heuristic, not a gate. It always returns a row — never throws, never
 * returns undefined — so a sheet shaped strangely enough to defeat the heuristic degrades to
 * today's topmost-occupied-row behaviour rather than blocking ingestion.
 */
export function detectHeaderRow(cells: readonly HeaderDetectionCell[]): number {
  const occupiedRows = Array.from(new Set(cells.map((cell) => cell.row))).sort((a, b) => a - b);
  if (occupiedRows.length === 0) {
    return 1;
  }

  const scannedRows = occupiedRows.slice(0, MAX_SCANNED_ROWS);
  for (const rowNumber of scannedRows) {
    /**
     * Blank text is filtered here rather than assumed away. Both parsers that feed this today skip
     * empty cells, so in practice nothing is dropped — but the two conditions below are stated in
     * terms of non-empty cells, and a future caller that passes blanks would otherwise satisfy
     * them with a row that is mostly empty.
     */
    const rowTexts = cells
      .filter((cell) => cell.row === rowNumber && cell.text.trim().length > 0)
      .map((cell) => cell.text);
    const distinctValues = new Set(rowTexts).size;
    const hasOccupiedRowAfter = occupiedRows.some((row) => row > rowNumber);

    if (rowTexts.length >= 2 && distinctValues >= 2 && hasOccupiedRowAfter) {
      return rowNumber;
    }
  }

  return occupiedRows[0];
}
