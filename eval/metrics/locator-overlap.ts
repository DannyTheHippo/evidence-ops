import type { EvidenceLocator } from '../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { locateQuote } from '../../src/features/evidence/qa/locate-quote';
import type { Locator } from '../dataset/schema';
import { resolveLocatorText } from '../resolve-locator';

/**
 * A retrieved chunk carries a `docVersionId`, never a filename — `EvidenceLocator` (the chunk
 * side) has no `file` field at all (see `evidence-locator.type.ts`), only the dataset's own
 * `Locator` union does. Callers resolve `docVersionId -> filename` from the map built at ingest
 * time (`eval/ingest-fixtures.ts`) before calling `chunkOverlapsLocator`.
 */
export interface OverlapCandidateChunk {
  readonly filename: string;
  readonly text: string;
  readonly locator: EvidenceLocator;
}

interface CellAddress {
  readonly column: number;
  readonly row: number;
}

// Deliberately not imported from `resolve-locator.ts`'s private `parseAddress`/`columnToIndex`:
// that module is out of this change's grant (`eval/metrics/`, `eval/dataset/`), and its own
// `addressMatches` assumes the *target* side of the comparison is always a single cell — true for
// every other caller, but not here (see `rangesOverlap` below). Small, self-contained duplicate
// rather than widening an out-of-scope file's contract.
function parseCellAddress(address: string): CellAddress {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) {
    throw new Error(`not an A1-style cell address: ${address}`);
  }
  const column = match[1]
    .split('')
    .reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1), 0);
  return { column, row: Number(match[2]) };
}

interface CellRectangle {
  readonly minRow: number;
  readonly maxRow: number;
  readonly minColumn: number;
  readonly maxColumn: number;
}

function parseRange(spec: string): CellRectangle {
  const [startText, endText] = spec.split(':');
  const start = parseCellAddress(startText);
  const end = parseCellAddress(endText ?? startText);
  return {
    minRow: Math.min(start.row, end.row),
    maxRow: Math.max(start.row, end.row),
    minColumn: Math.min(start.column, end.column),
    maxColumn: Math.max(start.column, end.column),
  };
}

/**
 * Rectangle intersection, not containment: `chunkSheet`'s row-windows (`chunker.ts`) partition a
 * sheet without overlap, so a ground-truth locator that is itself a multi-row range (the schema
 * allows "A2:H11", not only a single cell) can legitimately straddle two adjacent windows' row
 * boundary. A point-in-rectangle check (does the chunk's range contain the locator's single cell)
 * silently degrades to "matches at most the one window containing the locator's start cell" —
 * wrong the moment a locator's row span crosses a window boundary, and it throws outright on a
 * range-shaped `cell` because the single-cell address regex rejects the colon. Intersection is the
 * correct, general test: a chunk overlaps a locator whenever their rectangles share any cell,
 * matching *every* window a spanning locator touches, not just the first.
 */
function rangesOverlap(rangeA: string, rangeB: string): boolean {
  const a = parseRange(rangeA);
  const b = parseRange(rangeB);
  return (
    a.minRow <= b.maxRow &&
    b.minRow <= a.maxRow &&
    a.minColumn <= b.maxColumn &&
    b.minColumn <= a.maxColumn
  );
}

/**
 * Whether a retrieved chunk actually covers a dataset ground-truth locator ("span overlap" per
 * `eval/dataset/README.md`).
 *
 * `xlsx-cell` is a structural check: `EvidenceLocator`'s spreadsheet variant is always
 * `xlsx-region` (`chunker.ts`'s `chunkSheet` never emits a per-cell locator on a chunk), so
 * rectangle intersection between the dataset's cell-or-range and the chunk's declared range
 * (`rangesOverlap`, below) is exact and cheap.
 *
 * `pdf-page`/`docx-paragraph` cannot use the equivalent equality check: `chunker.ts`'s
 * `anchorLocator` anchors a multi-element chunk to only its *first* page/paragraph (see that
 * function's doc comment), so a chunk whose text runs from page 2 into page 4 still reports
 * `page: 2`. Equality would silently undercount recall for exactly the chunks a token-budget
 * window is likely to produce. Instead this resolves the dataset locator's own text (the same
 * parsers ingestion used, via `resolveLocatorText`) and checks whether that text is actually
 * present in the chunk — `locateQuote`'s normalized containment, the same check
 * `GroundingGateService` uses to verify a citation's quote against its cited chunk, applied here to
 * a whole element instead of a citation-length excerpt. This is a bound worth stating (see
 * `docs/adr/0007-eval-replay-cache.md`): it is a text-containment approximation of span overlap,
 * not a byte-range intersection.
 */
export async function chunkOverlapsLocator(
  chunk: OverlapCandidateChunk,
  locator: Locator,
): Promise<boolean> {
  if (chunk.filename !== locator.file) {
    return false;
  }

  if (locator.kind === 'xlsx-cell') {
    if (chunk.locator.kind !== 'xlsx-region') {
      return false;
    }
    return (
      chunk.locator.sheetName === locator.sheet && rangesOverlap(chunk.locator.range, locator.cell)
    );
  }

  if (locator.kind === 'pdf-page' && chunk.locator.kind !== 'pdf-page') {
    return false;
  }
  if (locator.kind === 'docx-paragraph' && chunk.locator.kind !== 'docx-paragraph') {
    return false;
  }

  const expectedText = await resolveLocatorText(locator);
  if (expectedText.trim() === '') {
    return false;
  }

  return locateQuote(expectedText, chunk.text).kind === 'exact';
}

/**
 * True if any of a chunk's overlaps hold against any of a case's `expectedLocators` — the
 * per-case recall predicate `compute-metrics.ts` needs, without every call site re-deriving "some"
 * from `chunkOverlapsLocator` itself.
 */
export async function chunkOverlapsAnyLocator(
  chunk: OverlapCandidateChunk,
  locators: readonly Locator[],
): Promise<boolean> {
  for (const locator of locators) {
    if (await chunkOverlapsLocator(chunk, locator)) {
      return true;
    }
  }
  return false;
}
