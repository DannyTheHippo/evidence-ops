import { normalizeQuoteText } from '../../../shared/utils/normalize-quote-text.util';
import { extractNumericTokens } from './extract-numeric-tokens';

/** A quote below this many content tokens cannot possibly support anything — a bare "the" carries
 * zero, a lone proper noun carries one. Absolute, not a ratio, and deliberately low: this exists
 * only to reject a quote with no content of its own, never to impose a minimum quote length. */
export const MIN_QUOTE_CONTENT_TOKENS = 3;

/** A claim sharing fewer than this many word tokens with the union of its own quotes, and no
 * corroborated numeric token either, is not about the evidence it cites — a quote can be substantive
 * and still unrelated to the statement it is attached to. Absolute, not a ratio: a ratio would reject
 * legitimate heavy paraphrase, where a claim and its supporting quote share almost no surface tokens
 * despite one describing the other ("two five-year renewal options" against "two (2) successive
 * periods of five (5) years each"). Governs word-only overlap: a shared numeric token never counts
 * toward this floor, corroborated or not — see `checkQuoteAlignment` for why a corroborated number
 * instead clears alignment on its own, and an uncorroborated one never contributes at all. */
export const MIN_SHARED_CONTENT_TOKENS = 2;

// Closed and deliberately small: common function words that survive the <3-character floor below
// (which already drops "a", "an", "of", "to", "in", "at") but still carry no content of their own.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'was',
  'were',
  'have',
  'shall',
  'each',
  'are',
  'its',
  'into',
  'upon',
  'such',
  'any',
  'all',
  'may',
  'can',
]);

const MIN_WORD_TOKEN_LENGTH = 3;

/**
 * Content tokens of a piece of text: words that are not in `STOPWORDS`, plus every numeric literal
 * `extractNumericTokens` finds (tagged `#<value>` so a word and a number can never collide as
 * tokens). Numbers are exempt from the length floor and the stopword filter — a claim about "$5"
 * would otherwise contribute zero content tokens for its only substantive fact. Reuses
 * `normalizeQuoteText` so a reflowed line break or a re-typed smart quote does not change what
 * counts as a token, matching `locateQuote`'s own normalization; unlike `locateQuote`, this also
 * lowercases, because token overlap is a content-matching concern, not a verbatim-quoting one.
 *
 * Word tokens are split on any run of characters that is neither a Unicode letter (`\p{L}`) nor a
 * Unicode number (`\p{N}`), so a hyphenated compound ("five-year") contributes both halves — the
 * shared-token floor depends on this to recognize "five" inside "five-year" — and this holds for
 * every script, not only ASCII. The `MIN_WORD_TOKEN_LENGTH` floor and the `STOPWORDS` filter apply
 * only to tokens made entirely of ASCII letters/digits; a token containing any non-ASCII character
 * is kept regardless of length. That floor exists to drop short English function-word fragments, and
 * a CJK, Cyrillic, or Greek content word is routinely one or two characters — holding it to a floor
 * tuned for English would erase it outright. `STOPWORDS` is an English list for the same reason: it
 * has nothing to filter in another script, so the exemption costs nothing there. This does not give
 * CJK text word-level segmentation — a run of contiguous CJK characters with no separator between
 * them still becomes a single token — so overlap for scripts without whitespace-separated words stays
 * substring-level, not word-level.
 */
function extractContentTokens(text: string): Set<string> {
  const normalized = normalizeQuoteText(text).toLowerCase();

  const numericTokens = extractNumericTokens(normalized).map((value) => `#${value}`);

  const wordTokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !/^\d+$/.test(token))
    .filter((token) => {
      const isAsciiOnly = /^[a-z0-9]+$/.test(token);
      return !isAsciiOnly || (token.length >= MIN_WORD_TOKEN_LENGTH && !STOPWORDS.has(token));
    });

  return new Set([...wordTokens, ...numericTokens]);
}

export type QuoteAlignmentResult =
  | { readonly kind: 'aligned' }
  | { readonly kind: 'quote-not-substantive'; readonly quoteIndex: number }
  | { readonly kind: 'quote-unrelated-to-statement' };

/**
 * Checks that a claim's cited quotes actually have something to do with the claim's statement — a
 * gap neither `locateQuote` nor the numeric check can close, since both verify a quote only against
 * its *chunk*, never against the *statement* it is supposed to support. A citation quoting `"the"`
 * passes chunk containment trivially; a citation quoting a real, substantive sentence that happens
 * to share nothing with the claim it is attached to passes it just as trivially.
 *
 * `corroboratedNumericTokens` is the set of numeric values the caller has already matched to a cell
 * fact on one of the claim's cited chunks — independent, structured evidence, not something this
 * module can derive from the statement/quote strings alone. A number merely present in both the
 * statement and a quote is not evidence of alignment on its own: it is the same coincidence for a
 * claim about a document's other numbers as it is for a claim genuinely about the cited fact (a
 * claim stating an unrelated fact and a quote about something else can still share a year). A
 * *corroborated* number is a materially stronger signal than a shared word, precisely because it
 * comes from a source the statement/quote pair cannot manufacture between them — a locator like
 * `XlsxCellLocator` addresses a single spreadsheet cell, so a cell quote is terse by construction and
 * can correctly support a prose statement while sharing almost no words with it (a claim about "the
 * property" citing a cell reading only "Sale Price (USD): 41000000", with a cell fact of the same
 * amount on that chunk, shares the number and nothing else).
 *
 * Two gates, each satisfied one of two ways:
 * - **Substance** (per quote): the quote has at least `MIN_QUOTE_CONTENT_TOKENS` content tokens, or
 *   it carries a corroborated numeric token — a terse cell quote that is *only* a corroborated value
 *   ("41000000") still passes, since the corroboration is itself the substance.
 * - **Overlap** (over the whole claim): shared word tokens reach `MIN_SHARED_CONTENT_TOKENS`, or at
 *   least one shared numeric token is corroborated. An uncorroborated shared number never counts
 *   toward either path — not as its own signal, not pooled with a shared word — since it is exactly
 *   the coincidence this check exists to reject.
 *
 * This is a measurement-and-veto gate on the answer path and fails CLOSED: a quote failing the
 * substance gate, or a claim whose quotes fail the overlap gate, is unaligned — the caller drops the
 * claim, exactly as it does for every other verification failure in `verifyClaim`.
 */
export function checkQuoteAlignment(params: {
  readonly statement: string;
  readonly quotes: readonly string[];
  readonly corroboratedNumericTokens?: ReadonlySet<number>;
}): QuoteAlignmentResult {
  const { statement, quotes, corroboratedNumericTokens = new Set<number>() } = params;
  const corroborated = new Set([...corroboratedNumericTokens].map((amount) => `#${amount}`));

  for (const [quoteIndex, quote] of quotes.entries()) {
    const tokens = extractContentTokens(quote);
    const carriesCorroboratedNumber = [...tokens].some((token) => corroborated.has(token));
    if (tokens.size < MIN_QUOTE_CONTENT_TOKENS && !carriesCorroboratedNumber) {
      return { kind: 'quote-not-substantive', quoteIndex };
    }
  }

  const statementTokens = extractContentTokens(statement);
  const quoteTokens = new Set(quotes.flatMap((quote) => [...extractContentTokens(quote)]));
  const sharedTokens = [...quoteTokens].filter((token) => statementTokens.has(token));
  const sharedWordTokens = sharedTokens.filter((token) => !token.startsWith('#'));
  const sharedCorroboratedNumeric = sharedTokens.some(
    (token) => token.startsWith('#') && corroborated.has(token),
  );

  return sharedCorroboratedNumeric || sharedWordTokens.length >= MIN_SHARED_CONTENT_TOKENS
    ? { kind: 'aligned' }
    : { kind: 'quote-unrelated-to-statement' };
}
