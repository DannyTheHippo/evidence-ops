const DIGIT_CHAR = /[0-9]/;
const NUMERIC_SEPARATOR_CHAR = /[.,]/;
const NUMERIC_BOUNDARY_CHAR = /[0-9.,]/;

/** Whether `char` is a bare digit — the one always-continues-a-number case, shared by the leading
 * edge (`isNumericBoundaryChar`) and the trailing edge (`continuesNumberAt`). */
function isDigit(char: string | undefined): boolean {
  return char !== undefined && DIGIT_CHAR.test(char);
}

/** Whether `char` would let a numeric match run together with a longer number instead of ending
 * cleanly at a word boundary — a digit continues the same number, and `.`/`,` are the separators a
 * formatted number uses internally (thousands commas, a decimal point). Used for the leading edge
 * only: a needle can never legitimately begin with a `.`/`,` continuing a prior digit run without
 * also starting with a digit of its own, so unlike the trailing edge (`continuesNumberAt`) this
 * doesn't need to look further back to tell a separator from terminal punctuation. */
function isNumericBoundaryChar(char: string | undefined): boolean {
  return char !== undefined && NUMERIC_BOUNDARY_CHAR.test(char);
}

/**
 * Whether `haystack[index]` continues the same number a digit-ending needle just matched, rather
 * than terminating it. A digit always continues it. A `.`/`,` continues it only when the character
 * after *that* is itself a digit — a formatted number's internal separator (thousands comma,
 * decimal point) is always followed by more digits, so a `.`/`,` with nothing digit-shaped after it
 * (end of string, a space, another punctuation mark) cannot be one: it's terminal punctuation, most
 * often a sentence's own full stop landing immediately after a cited figure, which free-form prose
 * does routinely. Anything else (a space, a letter, a currency symbol) never continues a number.
 */
function continuesNumberAt(haystack: string, index: number): boolean {
  const char = haystack[index];
  if (char === undefined) {
    return false;
  }
  if (DIGIT_CHAR.test(char)) {
    return true;
  }
  if (NUMERIC_SEPARATOR_CHAR.test(char)) {
    return isDigit(haystack[index + 1]);
  }
  return false;
}

/**
 * Whether `edge` — the first or last character of a needle — participates in a number, so that
 * `includesWithNumericBoundary` knows to guard that side. A bare digit always does. A `.`/`,`
 * separator does only when `adjacent` — the next character inward, i.e. the needle's second or
 * second-to-last character — is itself a digit: that is what distinguishes a numeric needle's own
 * internal separator (`'5,'`, `'.5'`, `',000'`) from a separator that merely sits at the edge of a
 * non-numeric needle (`'Vantage Fulfillment Co.'`), which must not trigger the guard.
 */
function isNumericNeedleEdge(edge: string | undefined, adjacent: string | undefined): boolean {
  if (edge === undefined) {
    return false;
  }
  return DIGIT_CHAR.test(edge) || (NUMERIC_SEPARATOR_CHAR.test(edge) && isDigit(adjacent));
}

/**
 * `haystack.includes(needle)`, except a `needle` whose edge participates in a number
 * (`isNumericNeedleEdge`) must not match flush against a longer number in `haystack` — plain
 * substring containment lets a short numeric expectation like `'5%'` match inside `'25%'`, or
 * `'4.1%'` match inside `'14.1%'`, which would report a case correct when the actual figure the
 * answer stated was a different number entirely. The trailing edge (`continuesNumberAt`)
 * additionally tolerates a `.`/`,` immediately after the needle when nothing digit-shaped follows
 * it, so a cited figure sitting at the end of a sentence still matches cleanly instead of being
 * rejected as if the sentence's own period were continuing the number. Non-numeric needles (a
 * tenant name, a full phrase) are unaffected even when they happen to start or end with `.`/`,`: a
 * word-boundary rule there would reject legitimate prose matches this check has no reason to
 * require.
 */
function includesWithNumericBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  const needleStartIsNumeric = isNumericNeedleEdge(needle[0], needle[1]);
  const needleEndIsNumeric = isNumericNeedleEdge(
    needle[needle.length - 1],
    needle[needle.length - 2],
  );

  let searchFrom = 0;
  for (;;) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) {
      return false;
    }
    const before = index > 0 ? haystack[index - 1] : undefined;
    const startBoundaryOk = !needleStartIsNumeric || !isNumericBoundaryChar(before);
    const endBoundaryOk =
      !needleEndIsNumeric || !continuesNumberAt(haystack, index + needle.length);
    if (startBoundaryOk && endBoundaryOk) {
      return true;
    }
    searchFrom = index + 1;
  }
}

/**
 * Whether every dataset-declared substring in `expectedAnswerContains` appears in the answer text
 * an `answerable` case actually produced. Comparison is case-insensitive on whitespace-normalized
 * text: `expectedAnswerContains` is written exactly as the source document renders a figure
 * ("5.25%"), but the model's own prose is free to differ in case or surrounding whitespace without
 * that being a real answer-correctness failure. A numeric expectation additionally requires a clean
 * boundary against adjacent digits (`includesWithNumericBoundary`) so a short figure cannot match
 * merely because it is a substring of a longer, different one.
 */
export function answerContainsExpectedStrings(
  answerText: string,
  expectedAnswerContains: readonly string[],
): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedAnswer = normalize(answerText);
  return expectedAnswerContains.every((expected) =>
    includesWithNumericBoundary(normalizedAnswer, normalize(expected)),
  );
}

/** The minimal shape `conflictValuesContainExpectedStrings` needs from one side of a
 * `conflicting_evidence` outcome (`ConflictedFactValue`, `conflicts.service.ts`) — value and unit
 * only, not `sourceChunkId`, which `conflict-scope-check.ts` already owns. */
export interface ConflictingValue {
  readonly value: number;
  readonly unit: string;
}

const PERCENT_UNIT = 'percent';

/**
 * Every textual form a value's number could plausibly render as in a source document — plain
 * digits, thousands-grouped, and fixed to 2 decimal places — because a `conflicting_evidence`
 * outcome's `values` carry only the bare extracted number and unit, never which convention the
 * source document actually used to display it ("3,891,300" in a formatted spreadsheet cell vs.
 * "4150000" pasted unformatted into a CSV). The fixed-to-2 form additionally recovers a trailing
 * zero a JS number drops on parse (`Number("6.10")` is `6.1`, so the plain and grouped forms alone
 * can never reproduce "6.10"). A `percent`-unit value also gets a `%`-suffixed form of each, since
 * `expectedAnswerContains` is written the way a document renders a percentage ("5.25%"), not
 * spelled out ("5.25 percent").
 */
function renderValueVariants(value: ConflictingValue): readonly string[] {
  const plain = String(value.value);
  const grouped = value.value.toLocaleString('en-US', { maximumFractionDigits: 10 });
  const fixed = value.value.toFixed(2);
  const variants = [...new Set([plain, grouped, fixed])];
  return value.unit === PERCENT_UNIT
    ? [...variants, ...variants.map((variant) => `${variant}%`)]
    : variants;
}

/**
 * The `conflicting`-category analogue of `answerContainsExpectedStrings` above. A `conflicting`
 * case has no answer prose to check `expectedAnswerContains` against — its `expectedOutcome` is
 * `surface_conflict`, not `answer` — so its `expectedAnswerContains` names the disagreeing figures
 * the seeded conflict is about instead; this checks that every one of them is among the rendered
 * forms (`renderValueVariants`) of the values a `conflicting_evidence` outcome actually attached,
 * reusing the same numeric-boundary containment rule so a short figure can't match inside a longer,
 * different one.
 */
export function conflictValuesContainExpectedStrings(
  values: readonly ConflictingValue[],
  expectedAnswerContains: readonly string[],
): boolean {
  const renderedText = values.flatMap(renderValueVariants).join(' ');
  return answerContainsExpectedStrings(renderedText, expectedAnswerContains);
}
