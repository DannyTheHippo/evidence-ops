import { normalizeQuoteText } from '../../../shared/utils/normalize-quote-text.util';
import { extractNumericTokens } from './extract-numeric-tokens';

/** A quote below this many content tokens cannot possibly support anything — a bare "the" carries
 * zero, a lone proper noun carries one. Absolute, not a ratio, and deliberately low: this exists
 * only to reject a quote with no content of its own, never to impose a minimum quote length. */
export const MIN_QUOTE_CONTENT_TOKENS = 3;

/** The absolute floor of the shared-word-token requirement — never the whole rule below a long
 * statement, see `SHARED_CONTENT_TOKEN_RATIO`. Kept low enough that it, alone, does not reject
 * legitimate heavy paraphrase on a short statement, where a claim and its supporting quote share
 * almost no surface tokens despite one describing the other ("two five-year renewal options"
 * against "two (2) successive periods of five (5) years each"). Governs word-only overlap: a shared
 * numeric token never counts toward this floor, corroborated or not — see `checkQuoteAlignment` for
 * why a corroborated number instead clears alignment on its own, and an uncorroborated one never
 * contributes at all. */
export const MIN_SHARED_CONTENT_TOKENS = 2;

/** Multiplies a statement's own word-token count (never the quotes', never a numeric token) to
 * produce the proportional part of the shared-token requirement, rounded up and floored at
 * `MIN_SHARED_CONTENT_TOKENS`. A fixed floor of 2 is trivial to clear for a long statement, where two
 * shared words say nothing about whether a claim's actual size is genuinely represented by its quote.
 * Every statement under 10 content words needs only `MIN_SHARED_CONTENT_TOKENS` shared tokens to align,
 * since `ceil(wordCount * 0.2)` stays at or below that floor for them; a 40-content-word statement needs
 * 8 shared tokens. See `docs/adr/0022-lexical-alignment-hardening.md` for why 0.2 is the chosen ratio. */
export const SHARED_CONTENT_TOKEN_RATIO = 0.2;

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

// Covers, by Unicode general category and binary property rather than an enumerated list: `\p{Cc}`
// C0/C1 controls other than tab/LF/CR (excluded here so that `normalizeQuoteText`'s `\s+` collapse,
// not this strip, is what joins them — see its own doc comment), every `\p{Cf}` format character
// (zero-width space/joiner/non-joiner, bidi format controls, soft hyphen), every
// `\p{Default_Ignorable_Code_Point}` and `\p{Bidi_Control}` code point, and every
// `\p{Grapheme_Extend}` combining mark (nonspacing and enclosing marks that attach to the preceding
// character rather than starting a new one). Every member renders with no visible separation of its
// own, so a reader perceives no word break where one sits, and deleting it reconstructs the word the
// reader actually sees: `n<zero-width space>ot` reads as `not`. A code point a reader does perceive
// as a gap is not in this class — it belongs to `PERCEIVED_WORD_BREAK_PATTERN` and is folded to a
// space instead. This class does not cover every code point that renders with no visible glyph in
// every font: Braille pattern blank (U+2800, `\p{So}`) is a residual `detectsNegation` closes a
// different way, through the two readings it tests rather than through a category strip.
const INVISIBLE_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Grapheme_Extend}]/gu;

// Every code point a reader perceives as a gap between words rather than as nothing: every
// `\p{Zs}` space separator other than U+0020 SPACE itself, which already is one, and the
// `\p{Zl}`/`\p{Zp}` line and paragraph separators. Expressed as a `v`-flag set difference rather
// than an enumerated list of the members, so a future Unicode `Zs` addition is covered without an
// update here. Every member folds to a space wherever text is canonicalized for comparison, and is
// never deleted. Deleting one would run in both harmful directions at once: it glues two real words
// into a single token that matches nothing on the other side, depressing the overlap count for the
// ordinary documents that carry these code points (U+2007 and U+2009 are routine PDF
// text-extraction output, U+3000 is the standard CJK word separator, U+202F is standard French
// typography and `Intl.DateTimeFormat` output); and it removes the word boundary the negation
// markers are matched on, so one planted around `not` hides a negation that still renders as a
// visible gap to the reader.
const PERCEIVED_WORD_BREAK_PATTERN = /[\p{Zl}\p{Zp}[\p{Zs}--[\u0020]]]/gv;

/**
 * Substitutes both classes of code point above: `wordBreak` replaces a perceived gap,
 * `invisible` replaces a character that renders as nothing. Perceived breaks are substituted first.
 * Shared by every canonicalization below, which differ only in which substitutes they pass.
 */
function neutralize(
  text: string,
  substitutes: { readonly wordBreak: string; readonly invisible: string },
): string {
  return text
    .replace(PERCEIVED_WORD_BREAK_PATTERN, substitutes.wordBreak)
    .replace(INVISIBLE_CHARACTER_PATTERN, substitutes.invisible);
}

/**
 * Canonicalizes text as a reader perceives it, for this module's token-overlap logic: a perceived
 * gap (`PERCEIVED_WORD_BREAK_PATTERN`) becomes a plain space, an invisible code point
 * (`INVISIBLE_CHARACTER_PATTERN`) is removed, then what remains is NFKC-folded, given
 * `normalizeQuoteText`'s ASCII substitutions, and lowercased. Order matters (CWE-180): substituting
 * and folding both happen before the text is ever split into tokens, never after. Substituting first
 * defeats a zero-width space or soft hyphen planted mid-word to break a contiguous match
 * (`n<zero-width space>ot`) while keeping a thin or ideographic space between two real words as the
 * word break it renders as; NFKC-folding after that collapses a compatibility variant — full-width
 * Latin, ligatures — to the plain form a word token actually expects.
 *
 * `detectsNegation` deliberately does not use this single reading — see its own doc comment.
 *
 * This is deliberately **not** applied to `locateQuote`'s verbatim-containment check, which
 * compares real bytes on purpose: that check exists to prove a quote's exact text is present in its
 * cited chunk, and canonicalizing away the difference would make it stop proving that. Only this
 * module's own alignment logic — which never claims to verify verbatim containment, only lexical
 * relatedness — canonicalizes before comparing.
 */
function canonicalizeForAlignment(text: string): string {
  return normalizeQuoteText(
    neutralize(text, { wordBreak: ' ', invisible: '' }).normalize('NFKC'),
  ).toLowerCase();
}

/**
 * Canonicalizes text for `containsMixedScriptToken` only — the same reader's reading
 * `canonicalizeForAlignment` uses, so a perceived gap keeps two adjacent words in different scripts
 * from merging into one token this gate would then refuse, but never NFKC-folded. NFKC maps
 * several compatibility symbols onto letters carrying a specific script (U+2126 OHM SIGN → U+03A9
 * Greek omega), which would make an ordinary token indistinguishable, at this checkpoint, from one a
 * real homoglyph substitution mixed scripts into. A genuine substitution is present in the text
 * before folding too, so checking pre-fold loses no detection and stops flagging tokens whose only
 * "mixed script" is a symbol's own compatibility mapping — U+00B5 MICRO SIGN, routine in a
 * measurement unit like "µg/m3", carries `Script=Common` before folding and so never mixes with the
 * Latin letters around it here, where its NFKC-folded form (U+03BC, `Script=Greek`) would.
 */
function canonicalizeForScriptCheck(text: string): string {
  return normalizeQuoteText(neutralize(text, { wordBreak: ' ', invisible: '' })).toLowerCase();
}

// Closed class of English negation markers, matched as whole words against
// `canonicalizeForAlignment`'d text — never just the literal "not". A single alternation handles the
// fixed markers; a second, generic `\w*n't\b` catches every English negative contraction (isn't,
// doesn't, can't, won't, couldn't, ...) without enumerating each one, since they all share the same
// "...n't" suffix. `without` carries a negative lookahead excluding "without limitation" — boilerplate
// ("including without limitation...") that appears in ordinary commercial-lease drafting and carries
// no negation of its own; every other use of "without" still counts. No `g` flag: this pattern is
// only ever consumed via `.test()`, and a global flag makes `.test()` stateful across calls (advancing
// `lastIndex`), which would silently miss matches on a second/third call.
const NEGATION_MARKER_PATTERN =
  /\b(?:not|no|never|none|neither|nor|cannot)\b|\bwithout\b(?!\s+limitation\b)|\b\w*n't\b/;

// The only characters `detectsNegation` treats as content or as a separator it can read, once its
// own canonicalization has run: a letter, a digit, or any printable ASCII character —
// the space every whitespace run collapses to, the apostrophe a contraction needs, and every ordinary
// punctuation mark, including one sitting directly against a marker word with no surrounding space
// ("not-remediated"). A reader perceives every one of those as either content or a real, visible
// break, so none of them may be squashed away — only what is neither a letter, a digit, nor printable
// ASCII is. An allowlist, not one more category folded into `INVISIBLE_CHARACTER_PATTERN` — a
// category-by-category strip only ever closes the gap for the code point that prompted it, and
// Unicode's `General_Category` has no property that isolates "renders with no visible ink" from a
// symbol's category-mates that do: U+2800 BRAILLE PATTERN BLANK renders nothing, but shares `\p{So}`
// with the other 255 code points in its own block, each of which raises at least one dot. Squashing
// this negation-only projection down to the allowlist substitutes a known-invisible character
// `INVISIBLE_CHARACTER_PATTERN` already handles, a symbol with no clean category test, and a code
// point not yet assigned, uniformly — and `detectsNegation` runs it under both of its substitutes, so
// an unrecognized character is read once as absent and once as a word break, never as only one of the
// two, whatever category Unicode later assigns it. Deliberately scoped to this negation check
// alone, never applied to `extractContentTokens`: that function's tokens flow into
// `extractNumericTokens`, which needs `$`, `,`, `.`, and `%` intact to parse a cited amount, and
// stripping every non-letter/non-digit character (rather than keeping printable ASCII) would remove
// all four.
const NEGATION_WORD_OR_ASCII_PATTERN = /[^\p{L}\p{N} -~]/gu;

function squashToWordsAndAsciiPunctuation(text: string, separator: string): string {
  return text.replace(NEGATION_WORD_OR_ASCII_PATTERN, separator);
}

/**
 * Whether `text` carries a negation marker under one reading of it: `separator` is what every code
 * point carrying no word content of its own is taken to mean — both classes above, and whatever the
 * closing squash to letters, digits and printable ASCII still catches. The empty string reads them
 * all as absent, joining the letters on either side into one word; a space reads them all as a word
 * break, separating those letters. Both readings run the same canonicalization order
 * `canonicalizeForAlignment` documents, so a marker is matched only after substitution and folding,
 * never before (CWE-180).
 */
function carriesNegationMarkerUnder(text: string, separator: string): boolean {
  const canonical = normalizeQuoteText(
    neutralize(text, { wordBreak: separator, invisible: separator }).normalize('NFKC'),
  ).toLowerCase();

  return NEGATION_MARKER_PATTERN.test(squashToWordsAndAsciiPunctuation(canonical, separator));
}

/** Whether `text` carries a negation marker at all — a coarse, whole-text signal, not a per-clause
 * one. `checkQuoteAlignment` uses this to compare a statement's polarity against its quotes': lexical
 * overlap alone cannot tell "the property was renovated" from "the property was not renovated" apart
 * — sharing every other word, they clear the shared-token floor identically, and "not" itself would
 * only help if the two sides happened to share it. This closes that gap the same way the rest of this
 * module does: lexically, not semantically — a claim negating a *different* clause than the one its
 * quote supports still passes, because this only compares "does either side contain a negation
 * marker", not which clause it attaches to.
 *
 * Both readings of the text are tested and either one finding a marker counts, because a single
 * reading is defeated from whichever side it does not cover. Read as absent, a code point planted
 * inside a marker is repaired (`n<thin space>ot` becomes "not") but one planted around a marker
 * joins it to its neighbours and erases the word boundary the markers are matched on
 * (`was<thin space>not<thin space>renovated` becomes one word carrying no marker). Read as a word
 * break, that second plant is repaired and the first is the one that hides. Neither plant is
 * detectable as an attack from the text alone — U+2007 and U+3000 are ordinary separators in real
 * documents — so both are read, rather than one of them guessed at.
 *
 * The union is the fail-closed combinator, which is what this gate needs: a marker found under
 * either reading makes the text negated, so the polarity comparison in `checkQuoteAlignment` is more
 * likely to disagree and drop the claim, never more likely to accept one. Over-detection costs a
 * dropped claim; under-detection passes a claim its own quote contradicts. */
function detectsNegation(text: string): boolean {
  return carriesNegationMarkerUnder(text, '') || carriesNegationMarkerUnder(text, ' ');
}

// Han, Hiragana, and Katakana are the scripts this codebase's word-boundary splitting
// (`extractContentTokens`'s `\p{L}`/`\p{N}` split) cannot handle: they carry no whitespace between
// words, so a whole unpunctuated clause collapses into a single oversized token no real segmentation
// library (forbidden here — no new dependency) would ever treat as one word. Cyrillic, Greek, Hebrew,
// Arabic, and Hangul are deliberately excluded — all of them separate words with whitespace, so the
// existing split already produces real word-level tokens for them (see the Cyrillic case covered
// below). Thai, Lao, Khmer, and Myanmar share the same no-whitespace problem as Han/Kana but are not
// covered by this pattern (see the ADR for the bound).
const UNSEGMENTED_SCRIPT_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;

function containsUnsegmentedScript(text: string): boolean {
  return UNSEGMENTED_SCRIPT_PATTERN.test(text);
}

const LATIN_SCRIPT_PATTERN = /\p{Script=Latin}/u;
const NO_SCRIPT_IDENTITY_PATTERN = /\p{Script=Common}|\p{Script=Inherited}/u;

/** A letter carrying a script identity other than Latin — `\p{Script=Common}` (digits, most
 * punctuation) and `\p{Script=Inherited}` (combining marks) are excluded because neither carries a
 * script of its own, so neither can make a token "mixed" on its own. */
function isOtherScriptLetter(char: string): boolean {
  return (
    /\p{L}/u.test(char) &&
    !LATIN_SCRIPT_PATTERN.test(char) &&
    !NO_SCRIPT_IDENTITY_PATTERN.test(char)
  );
}

/**
 * Whether `token` combines a Latin letter with a letter from any other script — the coarse signal a
 * homoglyph substitution leaves behind. A Cyrillic "о" (U+043E) swapped into an otherwise-Latin word
 * ("n<Cyrillic о>t") reads identically to a human and would tokenize and negation-match exactly like
 * the Latin word it impersonates, since the two codepoints are not related by any Unicode
 * normalization form — NFKC does not fold confusables, only compatibility variants of the *same*
 * underlying character (see `canonicalizeForAlignment`). This is a script-mixing check, not a
 * confusables table: it does not know which specific letter pairs look alike, only that a single word
 * combining two scripts was not typed by a human writing in one script, and refuses rather than
 * attempt a half-match no character-pair table here would ever cover completely.
 */
function isMixedScriptToken(token: string): boolean {
  let hasLatin = false;
  let hasOtherScript = false;
  for (const char of token) {
    if (LATIN_SCRIPT_PATTERN.test(char)) hasLatin = true;
    else if (isOtherScriptLetter(char)) hasOtherScript = true;
  }
  return hasLatin && hasOtherScript;
}

/** Whether any word token of `text` (after `canonicalizeForScriptCheck` — perceived gaps folded to a
 * space and invisibles removed, but deliberately not NFKC-folded, see that function's own doc
 * comment) mixes scripts. Split on the same
 * `[^\p{L}\p{N}]+` boundary `extractContentTokens` uses, so a mixed-script word is caught at the same
 * granularity it would otherwise be tokenized at. */
function containsMixedScriptToken(text: string): boolean {
  return canonicalizeForScriptCheck(text)
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length > 0 && isMixedScriptToken(token));
}

/**
 * Content tokens of a piece of text: words that are not in `STOPWORDS`, plus every numeric literal
 * `extractNumericTokens` finds (tagged `#<value>` so a word and a number can never collide as
 * tokens). Numbers are exempt from the length floor and the stopword filter — a claim about "$5"
 * would otherwise contribute zero content tokens for its only substantive fact. Reuses
 * `canonicalizeForAlignment`, which layers perceived-gap folding, invisible-character removal and
 * NFKC-folding on top of
 * `normalizeQuoteText`'s reflowed-line-break and smart-quote handling, then lowercases — a wider
 * canonicalization than `locateQuote` performs, because token overlap is a content-matching concern,
 * not the verbatim-quoting one `locateQuote` exists to prove (see `canonicalizeForAlignment`'s own
 * doc comment for why the two paths deliberately diverge).
 *
 * Word tokens are split on any run of characters that is neither a Unicode letter (`\p{L}`) nor a
 * Unicode number (`\p{N}`), so a hyphenated compound ("five-year") contributes both halves — the
 * shared-token floor depends on this to recognize "five" inside "five-year" — and this holds for
 * every script, not only ASCII. The `MIN_WORD_TOKEN_LENGTH` floor and the `STOPWORDS` filter apply
 * only to tokens made entirely of ASCII letters/digits; a token containing any non-ASCII character
 * is kept regardless of length. That floor exists to drop short English function-word fragments, and
 * a CJK, Cyrillic, or Greek content word is routinely one or two characters — holding it to a floor
 * tuned for English would erase it outright. `STOPWORDS` is an English list for the same reason: it
 * has nothing to filter in another script, so the exemption costs nothing there. This is safe for
 * every whitespace-separated script (Cyrillic, Greek, Hebrew, Arabic, Hangul) because splitting on
 * `\p{L}`/`\p{N}` already produces real word-level tokens for them — the exemption only ever widens
 * which of those already-correct tokens survive. It is NOT safe for Han/Hiragana/Katakana text, which
 * carries no whitespace between words: a run of contiguous characters with no separator still becomes
 * one oversized token here, and exempting it from the length/stopword filters would let that one
 * coarse token stand in for word-level overlap it cannot actually provide. `checkQuoteAlignment`
 * refuses alignment outright before ever tokenizing text containing either script, rather than let
 * this function produce a token it cannot honestly compare — see `containsUnsegmentedScript`.
 */
export function extractContentTokens(text: string): Set<string> {
  const normalized = canonicalizeForAlignment(text);

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
  | { readonly kind: 'quote-unrelated-to-statement' }
  | { readonly kind: 'quote-contradicts-statement' }
  | { readonly kind: 'quote-script-unsupported' }
  | { readonly kind: 'quote-mixed-script' };

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
 * Three gates:
 * - **Substance** (per quote): the quote has at least `MIN_QUOTE_CONTENT_TOKENS` content tokens, or
 *   it carries a corroborated numeric token — a terse cell quote that is *only* a corroborated value
 *   ("41000000") still passes, since the corroboration is itself the substance.
 * - **Overlap** (over the whole claim): shared word tokens reach a floor that scales with the
 *   statement's own length (`MIN_SHARED_CONTENT_TOKENS`/`SHARED_CONTENT_TOKEN_RATIO`), or at least
 *   one shared numeric token is corroborated. An uncorroborated shared number never counts toward
 *   either path — not as its own signal, not pooled with a shared word — since it is exactly the
 *   coincidence this check exists to reject.
 * - **Polarity** (over the whole claim, only checked once the other two gates already pass): the
 *   statement and its quotes must agree on whether they are negated at all (`detectsNegation`). Word
 *   overlap alone cannot distinguish a claim from its own negation — "the property was renovated" and
 *   "the property was not renovated" share every word but "not", clearing the overlap gate identically
 *   — and "not" itself is deliberately not a stopword, so a claim that happens to share it with its
 *   quote would otherwise make that match look *stronger*, not weaker.
 *
 * A statement or quote containing Han, Hiragana, or Katakana script fails every gate immediately,
 * before any of the above runs (`containsUnsegmentedScript`) — see `extractContentTokens`'s doc
 * comment for why this codebase cannot tokenize those scripts at word granularity without adding a
 * segmentation dependency, and `docs/adr/0022-lexical-alignment-hardening.md` for why refusing is the
 * chosen failure mode rather than accepting a coarse, unreliable match.
 *
 * A statement or quote containing a word that mixes Latin with any other script also fails
 * immediately, checked right after the unsegmented-script gate and before any of the three gates
 * above run (`containsMixedScriptToken`) — see that function's own doc comment for why a script-mixed
 * token is refused rather than compared.
 *
 * This is a measurement-and-veto gate on the answer path and fails CLOSED: a quote failing the
 * substance gate, a claim whose quotes fail the overlap gate, a claim whose polarity disagrees with
 * its quotes, or a claim/quote in an unsegmentable or script-mixed word, is unaligned — the caller
 * drops the claim, exactly as it does for every other verification failure in `verifyClaim`. This
 * alignment is lexical — token and polarity-marker overlap — never entailment: it cannot verify that a
 * claim's *reasoning* from its quotes is sound, only that the two are not talking about different
 * things or asserting opposite things (`docs/adr/0022-lexical-alignment-hardening.md`).
 */
export function checkQuoteAlignment(params: {
  readonly statement: string;
  readonly quotes: readonly string[];
  readonly corroboratedNumericTokens?: ReadonlySet<number>;
}): QuoteAlignmentResult {
  const { statement, quotes, corroboratedNumericTokens = new Set<number>() } = params;
  const corroborated = new Set([...corroboratedNumericTokens].map((amount) => `#${amount}`));

  if (containsUnsegmentedScript(statement) || quotes.some(containsUnsegmentedScript)) {
    return { kind: 'quote-script-unsupported' };
  }

  if (containsMixedScriptToken(statement) || quotes.some(containsMixedScriptToken)) {
    return { kind: 'quote-mixed-script' };
  }

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

  const statementWordTokenCount = [...statementTokens].filter(
    (token) => !token.startsWith('#'),
  ).length;
  const requiredSharedWordTokens = Math.max(
    MIN_SHARED_CONTENT_TOKENS,
    Math.ceil(statementWordTokenCount * SHARED_CONTENT_TOKEN_RATIO),
  );

  if (!sharedCorroboratedNumeric && sharedWordTokens.length < requiredSharedWordTokens) {
    return { kind: 'quote-unrelated-to-statement' };
  }

  const statementNegated = detectsNegation(statement);
  const quotesNegated = quotes.some(detectsNegation);
  if (statementNegated !== quotesNegated) {
    return { kind: 'quote-contradicts-statement' };
  }

  return { kind: 'aligned' };
}
