import type { EvidenceLocator } from '../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { locateQuote } from '../../src/features/evidence/qa/locate-quote';
import type { Locator } from '../dataset/schema';
import { addressMatches, resolveLocatorText } from '../resolve-locator';

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

/**
 * Whether a retrieved chunk actually covers a dataset ground-truth locator ("span overlap" per
 * `eval/dataset/README.md`).
 *
 * `xlsx-cell` is a structural check: `EvidenceLocator`'s spreadsheet variant is always
 * `xlsx-region` (`chunker.ts`'s `chunkSheet` never emits a per-cell locator on a chunk), so
 * containment of the dataset's single cell inside the chunk's declared range
 * (`addressMatches`, shared with `resolve-locator.ts`) is exact and cheap.
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
      chunk.locator.sheetName === locator.sheet && addressMatches(chunk.locator.range, locator.cell)
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
