export interface HeaderDetectionCell {
  readonly row: number;
  readonly text: string;
}

// Real spreadsheets are not clean grids: a report-layout sheet often has a title (or a merged
// banner) sitting above the actual table. Scanning further than this risks a huge sheet's
// coincidental later run of duplicate-ish values reading as a header; this is a heuristic over the
// sheet's opening rows, not an audit of the whole thing.
const MAX_SCANNED_ROWS = 10;

export interface HeaderRowResolution {
  readonly headerRow: number;
  /**
   * Present only when this sheet's header could not be pinned down with confidence — threaded
   * through `extractXlsxFacts`'s own `reducedFidelityReasons` (xlsx-fact-extractor.ts) to
   * `FactsService.buildXlsxCandidates`, which appends it to `DocumentVersion.reducedFidelityReasons`
   * rather than silently trusting `headerRow`. Absent for the ordinary case: one row that clearly
   * qualifies, nothing else ambiguous about it.
   */
  readonly reducedFidelityReason?: string;
}

function nonEmptyRowTexts(cells: readonly HeaderDetectionCell[], rowNumber: number): string[] {
  /**
   * Blank text is filtered here rather than assumed away. Both parsers that feed this today skip
   * empty cells, so in practice nothing is dropped — but the two conditions below are stated in
   * terms of non-empty cells, and a future caller that passes blanks would otherwise satisfy them
   * with a row that is mostly empty.
   */
  return cells
    .filter((cell) => cell.row === rowNumber && cell.text.trim().length > 0)
    .map((cell) => cell.text);
}

/**
 * Finds the header row of one sheet's occupied cells, and names the two shapes it cannot
 * distinguish from a clean single-row header — this function only ever returns ONE row, so
 * whichever real header row it did not pick still gets read as data by a caller that acts on
 * `headerRow` alone.
 *
 * Scans occupied rows ascending, bounded to the first `MAX_SCANNED_ROWS` occupied rows. The header
 * is the first row with at least 2 non-empty cells, at least 2 DISTINCT cell values, and at least
 * one occupied row after it.
 *
 * The distinct-values condition is what makes this compose with `xlsx.parser.ts`'s merged-cell
 * propagation: a merged title propagated across eight columns produces eight non-empty cells but
 * only ONE distinct value, so it is correctly not mistaken for a header row.
 *
 * A qualifying row whose own non-empty cells repeat a value (`rowTexts.length > distinctValues` —
 * only possible once the row clears the 2-distinct bar above via values it also repeats) is a
 * grouping/category row spanning several columns without being merged ("Sale", "Sale", "Metrics",
 * "Metrics") — the shape a genuine two-row header takes, with the real column labels one row
 * below it read as data instead. Flagged, but still returned as `headerRow`: this heuristic has no
 * way to identify which of the two rows is the "real" one, only that the sheet has more header
 * structure than a single row can capture.
 *
 * No qualifying row within the scanned window falls back to the topmost occupied row and is
 * flagged too: a header-less sheet (no row reads as a header at all) hits this same fallback, and
 * the topmost occupied row is then read as the header even though it may be the first row of
 * data.
 *
 * Failure direction: this is a heuristic, not a gate. It always returns a row — never throws, never
 * returns undefined — so a sheet shaped strangely enough to defeat the heuristic degrades to
 * today's topmost-occupied-row behaviour rather than blocking ingestion; `reducedFidelityReason` is
 * how that degradation stays visible instead of silent.
 */
export function resolveHeaderRow(cells: readonly HeaderDetectionCell[]): HeaderRowResolution {
  const occupiedRows = Array.from(new Set(cells.map((cell) => cell.row))).sort((a, b) => a - b);
  if (occupiedRows.length === 0) {
    return { headerRow: 1 };
  }

  const scannedRows = occupiedRows.slice(0, MAX_SCANNED_ROWS);
  for (const rowNumber of scannedRows) {
    const rowTexts = nonEmptyRowTexts(cells, rowNumber);
    const distinctValues = new Set(rowTexts).size;
    const hasOccupiedRowAfter = occupiedRows.some((row) => row > rowNumber);

    if (rowTexts.length >= 2 && distinctValues >= 2 && hasOccupiedRowAfter) {
      if (rowTexts.length > distinctValues) {
        return {
          headerRow: rowNumber,
          reducedFidelityReason:
            `row ${rowNumber} qualifies as the header but repeats a value across its own cells ` +
            `(${rowTexts.length} non-empty cells, only ${distinctValues} distinct) — the shape a ` +
            'grouping row above a real two-row header takes, with its column labels one row below ' +
            'read as data instead',
        };
      }
      return { headerRow: rowNumber };
    }
  }

  return {
    headerRow: occupiedRows[0],
    reducedFidelityReason:
      `no row within the first ${MAX_SCANNED_ROWS} occupied rows looks like a header (at least 2 ` +
      'distinct non-empty cells followed by another occupied row) — the topmost occupied row was ' +
      "treated as the header, which may be the sheet's first row of data instead",
  };
}

/** Thin wrapper over {@link resolveHeaderRow} for callers (`chunker.ts`) that only ever need the
 *  row number, never the fidelity signal. */
export function detectHeaderRow(cells: readonly HeaderDetectionCell[]): number {
  return resolveHeaderRow(cells).headerRow;
}

export interface HeaderUnitMarker {
  /** `header` with the trailing unit marker removed — round-trips through `findMetricByAlias`'s
   *  exact-match comparison, so a header carrying a marker its own alias entry omits still
   *  resolves to the same metric once the marker is stripped. Identical to `header` when no
   *  marker is present. */
  readonly baseText: string;
  readonly unit: 'percent' | 'ratio' | undefined;
}

// A header that names its own unit disambiguates a bare number the cell's own display text
// cannot: a cell's "%" is the only marker `parsePercentageDisplay` (xlsx-fact-extractor.ts) can
// see in the cell text itself, so a column like "Cap Rate (%)" holding a bare `5.25` has no other
// signal. Matched as a trailing parenthesized suffix, case-insensitively.
const HEADER_UNIT_MARKER_PATTERN = /\s*\((%|percent|ratio)\)\s*$/i;

/** Splits a trailing `(%)`/`(percent)`/`(ratio)` unit marker off a column header, if present. */
export function parseHeaderUnitMarker(header: string): HeaderUnitMarker {
  const match = HEADER_UNIT_MARKER_PATTERN.exec(header);
  if (!match) {
    return { baseText: header, unit: undefined };
  }
  const marker = match[1].toLowerCase();
  return {
    baseText: header.slice(0, match.index).trim(),
    unit: marker === 'ratio' ? 'ratio' : 'percent',
  };
}
