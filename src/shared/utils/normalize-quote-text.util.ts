/**
 * Normalizes text for quote comparison: collapses whitespace runs (a model reflowing a line break
 * across a paragraph is not a fabrication) and maps curly quotes/en-dash/em-dash/minus-sign/NBSP to
 * their plain-ASCII equivalents (a model retyping a smart quote as straight, or vice versa, is not
 * a fabrication either). Deliberately does NOT lowercase or strip punctuation — a citation quote is
 * supposed to be verbatim, and case is part of "verbatim".
 */
const UNICODE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛]/g, "'"], // curly single quotes / low-9 / reversed-9
  [/[“”„‟]/g, '"'], // curly double quotes / low-9 / reversed-9
  [/[–—−]/g, '-'], // en dash / em dash / minus sign
  [/ /g, ' '], // non-breaking space
];

export function normalizeQuoteText(text: string): string {
  let normalized = text;
  for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/\s+/g, ' ').trim();
}
