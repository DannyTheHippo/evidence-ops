import { normalizeQuoteText } from './normalize-quote-text.util';

export type QuoteMatchKind = 'exact' | 'fuzzy' | 'none';

export interface QuoteMatch {
  readonly kind: QuoteMatchKind;
  /** 1 minus the normalized edit distance, in `[0, 1]`. Diagnostic only — see the threshold's own
   * comment for why nothing above `none` is ever treated as verified. */
  readonly similarity: number;
}

// Diagnostic-only, not an acceptance bar: `kind: 'exact'` is reached solely by normalized
// containment (below), never by this threshold. Its only job is labeling a rejection as `fuzzy`
// (a near-miss worth surfacing to a human/eval) rather than `none` (no real relationship to the
// chunk at all) — so no value of it can let a fabricated quote pass, only relabel how it fails.
export const FUZZY_SIMILARITY_THRESHOLD = 0.85;

/**
 * Minimum single-character edits to turn `pattern` into *some* substring of `text` — free start and
 * end inside `text`, but the *whole* pattern must be consumed (column `pattern.length`, not just
 * whichever column is smallest — a partial-pattern match sitting at distance 0 via the free-start
 * column `0` would otherwise always win and make every comparison report a perfect match). This is
 * the standard bounded approximate substring-matching recurrence (Sellers/Ukkonen):
 * `O(text.length * pattern.length)` time, `O(pattern.length)` space via a rolling row,
 * `currentRow[0] = 0` at every text position being the "free start" that makes it a substring
 * search rather than a whole-string edit distance.
 */
function bestSubstringEditDistance(text: string, pattern: string): number {
  const patternLength = pattern.length;
  let previousRow = Array.from({ length: patternLength + 1 }, (_, index) => index);
  // i = 0 case: matching the whole pattern against an empty prefix of text costs one insertion
  // per pattern character.
  let bestAtFullPattern = previousRow[patternLength];

  for (let i = 1; i <= text.length; i++) {
    const currentRow = new Array<number>(patternLength + 1);
    currentRow[0] = 0; // free start: zero pattern chars matched costs nothing at any text position
    for (let j = 1; j <= patternLength; j++) {
      const substitutionCost = text[i - 1] === pattern[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j] + 1, // delete a char from text
        currentRow[j - 1] + 1, // insert a char into text
        previousRow[j - 1] + substitutionCost, // match or substitute
      );
    }
    bestAtFullPattern = Math.min(bestAtFullPattern, currentRow[patternLength]); // free end
    previousRow = currentRow;
  }

  return bestAtFullPattern;
}

/**
 * Locates a citation's quote inside its cited chunk's text, on the normalized form (see
 * `normalizeQuoteText`) so a reflowed line break or a re-typed smart quote does not read as
 * fabrication. Exact normalized containment is the only passing outcome (`kind: 'exact'`); a quote
 * that only resembles the chunk text is `'fuzzy'`, and one with no real relationship is `'none'` —
 * callers MUST treat both as a verification failure. Never accept a quote you cannot locate.
 */
export function locateQuote(quote: string, chunkText: string): QuoteMatch {
  const normalizedQuote = normalizeQuoteText(quote);
  const normalizedChunk = normalizeQuoteText(chunkText);

  if (normalizedQuote.length === 0) {
    // Defensive: the contract's `quote` field is `min(1)`, but that guarantees non-empty *before*
    // normalization — a whitespace-only quote normalizes to `''`, which every string trivially
    // "contains" and would otherwise look like a pass below. Checked first, and treated as
    // unlocatable rather than verified.
    return { kind: 'none', similarity: 0 };
  }

  if (normalizedChunk.includes(normalizedQuote)) {
    return { kind: 'exact', similarity: 1 };
  }

  const distance = bestSubstringEditDistance(normalizedChunk, normalizedQuote);
  const similarity = Math.max(0, 1 - distance / normalizedQuote.length);

  return { kind: similarity >= FUZZY_SIMILARITY_THRESHOLD ? 'fuzzy' : 'none', similarity };
}
