// Optional `$`, a digit-comma run, an optional decimal part, an optional trailing `%`. No leading
// minus sign: real-estate metrics here are never negative, and supporting one would misparse a
// hyphenated span like a period ("2025-03") or an A1 range ("A1:C10" has no digit-hyphen-digit, but
// dates do) as a negative number.
const NUMERIC_TOKEN_PATTERN = /\$?\d[\d,]*(?:\.\d+)?%?/g;

/**
 * Extracts numeric literals from free text (a claim statement, a chunk's full text) as parsed
 * numbers, not substrings — comparing this check exactly (`===`) is what makes it correct where a
 * naive `chunkText.includes(numberAsString)` would both false-positive ("6.1" is a substring of
 * "6.10") and false-negative ("1,200" never appears verbatim in text that only ever writes "1200").
 * `$`, `,`, and `%` are stripped before parsing so "$1,200.50", "1200.50", and "1,200.5" all
 * compare equal.
 *
 * Known gap (see the grounding gate's own doc comment): this only recognizes digit-based numerals.
 * A claim or chunk stating a number in words ("six percent") is invisible to it.
 */
export function extractNumericTokens(text: string): number[] {
  const matches = text.match(NUMERIC_TOKEN_PATTERN) ?? [];
  // `NUMERIC_TOKEN_PATTERN` only ever matches a digit run with at most one decimal point, so
  // `Number(cleaned)` cannot produce `NaN`/`Infinity` here — no defensive check needed.
  return matches.map((match) => Number(match.replace(/[$,%]/g, '')));
}
