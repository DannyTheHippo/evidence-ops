const NUMERIC_BOUNDARY_CHAR = /[0-9.,]/;

/** Whether `char` would let a numeric match run together with a longer number instead of ending
 * cleanly at a word boundary — a digit continues the same number, and `.`/`,` are the separators
 * a formatted number uses internally (thousands commas, a decimal point). */
function isNumericBoundaryChar(char: string | undefined): boolean {
  return char !== undefined && NUMERIC_BOUNDARY_CHAR.test(char);
}

/**
 * `haystack.includes(needle)`, except a `needle` that starts or ends with a digit must not match
 * flush against another digit (or `.`/`,`) in `haystack` — plain substring containment lets a short
 * numeric expectation like `'5%'` match inside `'25%'`, or `'4.1%'` match inside `'14.1%'`, which
 * would report a case correct when the actual figure the answer stated was a different number
 * entirely. Non-numeric needles (a tenant name, a full phrase) are unaffected: a word-boundary rule
 * there would reject legitimate prose matches this check has no reason to require.
 */
function includesWithNumericBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  const needleStartsWithDigit = /^[0-9]/.test(needle);
  const needleEndsWithDigit = /[0-9]$/.test(needle);

  let searchFrom = 0;
  for (;;) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) {
      return false;
    }
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after =
      index + needle.length < haystack.length ? haystack[index + needle.length] : undefined;
    const startBoundaryOk = !needleStartsWithDigit || !isNumericBoundaryChar(before);
    const endBoundaryOk = !needleEndsWithDigit || !isNumericBoundaryChar(after);
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
