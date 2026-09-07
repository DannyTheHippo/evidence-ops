// Two alternatives, tried in this order at each position: an accounting-negative token first — a
// digit-comma run wrapped in literal parentheses, with an optional `$` either outside or inside the
// parens (`(41,000)`, `$(41,000)`, `($41,000)`) — the notation `xlsx.parser.ts`'s `formatNumber`
// produces for a `#,##0;(#,##0)`-style negative section, where the parentheses themselves are the
// sign, not decoration; then the plain positive form: optional `$`, a digit-comma run, an optional
// decimal part, an optional trailing `%`. Deliberately still refuses a bare leading minus sign — a
// minus, unlike a matched pair of parens, is ambiguous with a hyphenated span such as a period
// ("2025-03") or an A1 range ("A1:C10" has no digit-hyphen-digit, but dates do), and parsing one as a
// negative number would misread either.
const NUMERIC_TOKEN_PATTERN = /\$?\(\$?\d[\d,]*(?:\.\d+)?%?\)|\$?\d[\d,]*(?:\.\d+)?%?/g;

/**
 * A lookup table keyed by text taken from a document — built with a null prototype, so a key an
 * attacker controls can only ever resolve an own entry. A plain object literal's inherited
 * `Object.prototype` makes `'constructor' in {}` true and `({})['constructor']` the `Object`
 * function itself, which the declared value type says is impossible; `constructor` is also the one
 * `Object.prototype` member that survives lowercasing (`toString`/`valueOf`/`hasOwnProperty`
 * already are lowercase, `__proto__` tokenizes to `proto` since `_` is not `\p{L}`).
 *
 * Exported for `facts/xlsx-fact-extractor.ts`'s magnitude-suffix table, which indexes by the same
 * kind of document-derived key.
 */
export function wordLookup<T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

// Standard English cardinal-number vocabulary this module can normalize — bounded deliberately:
// ordinals ("first"), fractions ("half", "quarter"), and non-English number words are out of scope.
// No "negative"/"minus" entry: word-form negation stays unsupported here even though
// `NUMERIC_TOKEN_PATTERN` above now recognizes the unambiguous parenthesized accounting form for a
// digit run — a phrase like "negative six percent" still extracts 6, dropping the sign, the same
// asymmetry the digit pattern itself still carries for a bare leading minus (see that pattern's own
// comment on why one stays refused).
//
// Every word below is lowercased before lookup, so all three tables are built through `wordLookup`
// above rather than as plain object literals.
const ONES: Readonly<Record<string, number>> = wordLookup({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
});
const TENS: Readonly<Record<string, number>> = wordLookup({
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
});
const SCALES: Readonly<Record<string, number>> = wordLookup({
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
});
const DECIMAL_MARKER = 'point';

function isCardinalWord(word: string): boolean {
  return word in ONES || word in TENS || word in SCALES;
}

/**
 * Whether `value` is safe to return from this module: finite, and no larger in magnitude than
 * {@link Number.MAX_SAFE_INTEGER} — checked against `Math.abs` because `NUMERIC_TOKEN_PATTERN`'s
 * accounting-negative alternative can hand this an arbitrarily negative value. A digit run long
 * enough to overflow (`Number("1" + "0".repeat(400))`) or a scale-word run repeated enough to
 * overflow (`current *= 100` chained past `hundred hundred hundred ...`) both parse to `Infinity`; a
 * run past `MAX_SAFE_INTEGER` in either direction parses to a double that no longer uniquely
 * represents its source digits, so two source numbers a few units apart can collide on the same
 * returned value. Both are refused rather than returned — a token that cannot faithfully represent
 * what the text actually says must never register as extracted, the same fail-closed direction
 * `extractWordNumberTokens` already takes for a bare ambiguous "one".
 */
function isRepresentableToken(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/**
 * Scans `text` for runs of contiguous English cardinal-number words ("forty one million", "six") and
 * parses each run to its numeric value, following standard English number grammar: `ONES`/`TENS`
 * words accumulate into the current group, `hundred` multiplies the current group, and
 * `thousand`/`million`/`billion` close the current group into the running total at that scale. A
 * trailing `point` followed by one or more single-digit words ("point one two") appends a decimal
 * part digit by digit, matching how such numbers are actually spoken. Deliberately does not support
 * British "and" ("one hundred and five") — American "one hundred five" grammar only — to avoid
 * treating an unrelated conjunction between two independent numbers as part of one number's grammar.
 *
 * A bare, unscaled "one" (no `hundred`/`thousand`/... following it, no `point` before it) is dropped
 * rather than extracted: "one" is the one word in this vocabulary that is at least as often a pronoun
 * ("the only one", "each one") as a number, and a false extraction here only ever pushes the caller
 * toward rejecting a claim as numerically unsupported (`verify-claim.ts` check 4) — the fail-closed
 * direction this module's callers already accept, never the reverse.
 *
 * A run made entirely of scale words, with no `ONES`/`TENS` word anchoring it, is dropped too — "$41
 * million" tokenizes the digits and the word separately (digits are not `\p{L}`), so the word scanner
 * sees only a bare "million" with nothing in this vocabulary in front of it. Extracting `1,000,000`
 * from that bare word would silently invent a second, phantom number the statement never actually
 * states — a magnitude word genuinely modifying a digit ("$41 million") is exactly the case
 * `NUMERIC_TOKEN_PATTERN`'s own doc comment already names as unsupported (it parses as `41`, not
 * `41,000,000`), and this scanner does not close that gap by half-guessing the digit's magnitude from
 * an unrelated word match. "one hundred" still extracts, because "one" anchors it as a real word
 * number; "a million dollars" (no digit, no anchoring cardinal word either) extracts nothing, the
 * same "not a number this vocabulary can honestly parse" outcome any unanchored scale-word run
 * produces.
 *
 * Returns each match's value paired with its start offset in `text`, so `extractNumericTokens` can
 * merge word-number matches with digit-pattern matches in original text order.
 */
function extractWordNumberTokens(
  text: string,
): Array<{ readonly index: number; readonly end: number; readonly value: number }> {
  const words = [...text.matchAll(/\p{L}+/gu)].map((match) => ({
    word: match[0].toLowerCase(),
    index: match.index,
    end: match.index + match[0].length,
  }));

  const results: Array<{ index: number; end: number; value: number }> = [];
  let i = 0;
  while (i < words.length) {
    if (!isCardinalWord(words[i].word)) {
      i++;
      continue;
    }

    const startIndex = words[i].index;
    const integerWords: string[] = [];
    let hasAnchoringCardinal = false;
    let total = 0;
    let current = 0;
    let lastConsumedIndex = i;
    while (i < words.length && isCardinalWord(words[i].word)) {
      const word = words[i].word;
      integerWords.push(word);
      if (word in SCALES) {
        const scale = SCALES[word];
        if (scale === 100) {
          current = (current === 0 ? 1 : current) * 100;
        } else {
          total += (current === 0 ? 1 : current) * scale;
          current = 0;
        }
      } else {
        current += ONES[word] ?? TENS[word];
        hasAnchoringCardinal = true;
      }
      lastConsumedIndex = i;
      i++;
    }

    let value = total + current;
    let matchedDecimal = false;
    if (words[i]?.word === DECIMAL_MARKER) {
      let j = i + 1;
      let decimalDigits = '';
      while (j < words.length && words[j].word in ONES && ONES[words[j].word] <= 9) {
        decimalDigits += String(ONES[words[j].word]);
        j++;
      }
      if (decimalDigits.length > 0) {
        value = Number(`${value}.${decimalDigits}`);
        lastConsumedIndex = j - 1;
        i = j;
        matchedDecimal = true;
      }
    }

    const isBareAmbiguousOne =
      integerWords.length === 1 && integerWords[0] === 'one' && !matchedDecimal;
    if (!isBareAmbiguousOne && hasAnchoringCardinal && isRepresentableToken(value)) {
      results.push({ index: startIndex, end: words[lastConsumedIndex].end, value });
    }
  }

  return results;
}

/**
 * Parses one `NUMERIC_TOKEN_PATTERN` match to its signed numeric value. `$`, `,`, `%`, and the
 * parentheses of the accounting-negative alternative are all stripped before parsing — a match
 * containing `(` can only be that alternative (the plain positive alternative never matches a `(`
 * at all), so its presence alone is enough to negate the parsed magnitude.
 */
function parseNumericTokenValue(raw: string): number {
  const isNegative = raw.includes('(');
  const magnitude = Number(raw.replace(/[$,%()]/g, ''));
  return isNegative ? -magnitude : magnitude;
}

// Every code point Unicode classifies as a decimal digit (`\p{Nd}`) — matched against text that has
// already been NFKC-normalized (see `extractNumericTokens`/`containsUnrepresentableNumber`), so
// anything this pattern finds outside ASCII `0`-`9` is a digit script NFKC has no fold for
// (Arabic-Indic, Devanagari, ...), not a compatibility form the fold already collapsed.
const DECIMAL_DIGIT_RUN_PATTERN = /\p{Nd}+/gu;
const ASCII_DIGIT_RUN_PATTERN = /^[0-9]+$/;

/**
 * Whether `text` contains a digit run this module can see but cannot return a finite value for in
 * `extractNumericTokens` — two distinct reasons, both covered:
 *
 * - **Script**: a run of `\p{Nd}` digits with at least one character outside ASCII `0`-`9` (a number
 *   written in Arabic-Indic "١٢٢٠٠", Devanagari, ...) that NFKC does not fold to ASCII.
 * - **Magnitude**: an ASCII digit run (`NUMERIC_TOKEN_PATTERN`) that parses to a value
 *   `isRepresentableToken` rejects — long enough to overflow to `Infinity`, or past
 *   `Number.MAX_SAFE_INTEGER` where the parsed double no longer uniquely represents its source digits
 *   (an 18-digit account or parcel identifier lands here without anything exotic about the script it's
 *   written in).
 *
 * Both are the same underlying condition from a caller's point of view: `extractNumericTokens` omits
 * the token rather than emit a lossy or sentinel value for it (see that function's own doc comment on
 * why its return type promises only finite values), so `[]` reads identically to "this text states no
 * number at all" whichever reason produced it. `text` is NFKC-normalized internally, so a caller
 * passes raw text exactly as it would to `extractNumericTokens`.
 *
 * This is the module's *unrepresentability* signal, deliberately kept separate from
 * `extractNumericTokens`'s return value rather than folded into it. A caller that must distinguish
 * "this text states no number" from "this text states a number I cannot verify" consults this
 * predicate alongside `extractNumericTokens`; a caller that only ever wants real, verifiable values
 * (matching against a stored fact amount, tokenizing for lexical overlap) has no reason to call it at
 * all.
 *
 * Deliberately does **not** cover a spelled-out number that overflows in `extractWordNumberTokens`
 * (`'nine ' + 'hundred '.repeat(200)`): that construction carries no digit run at all, and the
 * overflow only exists because the input repeats a scale word far past anything standard English
 * grammar produces for a real quantity — it is not "a number a reader would recognize as stated" in
 * the way a legible digit run or a real spelled-out figure is, so treating it as a silently vanished
 * claim is the correct outcome, not a gap this signal needs to close.
 */
export function containsUnrepresentableNumber(text: string): boolean {
  const normalizedText = text.normalize('NFKC');

  const hasUnrepresentableScript = [...normalizedText.matchAll(DECIMAL_DIGIT_RUN_PATTERN)].some(
    (match) => !ASCII_DIGIT_RUN_PATTERN.test(match[0]),
  );
  if (hasUnrepresentableScript) return true;

  return [...normalizedText.matchAll(NUMERIC_TOKEN_PATTERN)].some(
    (match) => !isRepresentableToken(parseNumericTokenValue(match[0])),
  );
}

/**
 * Extracts numeric literals from free text (a claim statement, a chunk's full text) as parsed
 * numbers, not substrings — comparing this check exactly (`===`) is what makes it correct where a
 * naive `chunkText.includes(numberAsString)` would both false-positive ("6.1" is a substring of
 * "6.10") and false-negative ("1,200" never appears verbatim in text that only ever writes "1200").
 * `$`, `,`, and `%` are stripped before parsing so "$1,200.50", "1200.50", and "1,200.5" all
 * compare equal. A digit run wrapped in literal parentheses ("$(41,000)", "(41,000)") parses to its
 * negative value — the accounting notation `NUMERIC_TOKEN_PATTERN`'s own comment describes — so a
 * claim stating a negative figure this way can match a fact of the same negative amount. A bare
 * leading minus sign is still never read as a sign, for the reason that pattern's own comment gives:
 * "reported for period 2025-03" extracts `[2025, 3]`, never `[2025, -3]`.
 *
 * Also normalizes spelled-out English cardinal numbers ("six", "forty one million") via
 * `extractWordNumberTokens`, merged with the digit-pattern matches in original text order. A claim
 * stating "six percent" therefore extracts `[6]`, not `[]` — `verify-claim.ts`'s check 4
 * (`for (const claimedNumber of extractNumericTokens(...))`) treats an empty result as "this claim
 * states no number to verify", so normalizing the word form into the same numeric value a digit form
 * would produce is what lets that loop actually verify it, rather than pass the claim with nothing
 * checked.
 *
 * `text` is NFKC-normalized before any matching runs, so a compatibility digit form — full-width
 * ASCII ("１２２００") — reads as the plain digits it displays as and extracts identically to its
 * ASCII form, the same folding `check-quote-alignment.ts`'s `extractContentTokens` already applies
 * before calling this function.
 *
 * **Every element this function returns is finite** — never `NaN`, never `Infinity`. A digit run this
 * function cannot represent — written in a script NFKC does not fold to ASCII, or parsing to a value
 * `isRepresentableToken` rejects as too large to trust — is legible to a reader but has no value this
 * function can honestly return for it, and it is *omitted* here rather than represented by a lossy or
 * sentinel value — `containsUnrepresentableNumber` (above) is the separate, explicit signal for that
 * case. Every consumer of this function's return value (`===` against a `fact.value.amount`,
 * `Array.prototype.includes`, membership in a `Set`) uses an equality check that treats `NaN` as equal
 * to itself under SameValueZero (`includes`, `Set`) or would otherwise invite a caller to special-case
 * a sentinel it has no reason to know about — keeping the return type finite makes every one of those
 * call sites correct as written, with nothing to special-case.
 *
 * Known gap: ordinals ("sixth"), fractions ("half", "a couple", "a dozen"), non-English number
 * *words*, a digit-plus-magnitude-word mix ("$41 million" parses as `41`, never `41,000,000`, per
 * `extractWordNumberTokens`'s own doc comment on why an unanchored scale word is dropped), and a bare
 * leading minus sign (see `NUMERIC_TOKEN_PATTERN`'s own comment on why only the parenthesized
 * accounting form is recognized as negative) all remain unrecognized — `extractWordNumberTokens`'s
 * own doc comment states the bounded cardinal vocabulary this covers. A claim using one of those
 * remains invisible to this check exactly as it would if it stated no number at all;
 * `containsUnrepresentableNumber` only covers a *digit run* this module can see but not represent,
 * never a number spelled out in an unsupported vocabulary or a spelled-out number that overflows (see
 * that function's own doc comment on why the latter is deliberately excluded). NFKC folding also
 * normalizes other compatibility forms it was not written for — superscript digits and vulgar
 * fractions ("m²", "½") fold to plain digits too, so a unit string can incidentally extract a phantom
 * number; that number still has to match a real fact or chunk value to survive check 4, so the
 * failure direction stays fail-closed (a spurious token can only cause an unsupported claim to be
 * dropped, never the reverse).
 */
/** One number {@link extractNumericTokenMatches} found, plus the text offsets it was read from. */
export interface NumericTokenMatch {
  readonly index: number;
  readonly end: number;
  readonly value: number;
}

/**
 * {@link extractNumericTokens}'s underlying matches, index-sorted, each carrying the `[index, end)`
 * offsets in the NFKC-normalized text the value was read from.
 */
export function extractNumericTokenMatches(text: string): NumericTokenMatch[] {
  const normalizedText = text.normalize('NFKC');

  const digitMatches = [...normalizedText.matchAll(NUMERIC_TOKEN_PATTERN)]
    .map((match) => ({
      index: match.index,
      end: match.index + match[0].length,
      // `NUMERIC_TOKEN_PATTERN` bounds the decimal part but not the run of digits before it, so an
      // arbitrarily long digit run (a corpus artifact, not a real quantity) still matches and
      // `parseNumericTokenValue` can return `Infinity`/`-Infinity` or a value past
      // `Number.MAX_SAFE_INTEGER` in magnitude — filtered out below by `isRepresentableToken`, not
      // assumed away here.
      value: parseNumericTokenValue(match[0]),
    }))
    .filter((match) => isRepresentableToken(match.value));
  const wordMatches = extractWordNumberTokens(normalizedText);

  return [...digitMatches, ...wordMatches].sort((a, b) => a.index - b.index);
}

export function extractNumericTokens(text: string): number[] {
  return extractNumericTokenMatches(text).map((match) => match.value);
}
