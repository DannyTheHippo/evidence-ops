// The server's period keys for facts that named no readable period: a bare sentinel when the
// source stated nothing at all, and a prefixed key carrying the source text when it stated
// something the extractor could not parse.
const UNDATED = 'undated';
const UNPARSEABLE_PREFIX = `${UNDATED}:`;

/**
 * Display text for a ledger cell's period. The bare `undated` sentinel has no display form and
 * returns null — the table renders a dash for it and the drawer title omits the segment. An
 * `undated:<text>` key is a period the extractor could not read, shown with its source text so the
 * gap is legible rather than collapsed into the same dash as a source that stayed silent. A
 * prefixed key with no text left after the prefix carries nothing to show and returns null too.
 * Every other key is a parsed period and renders as itself.
 */
export function periodLabel(period: string): string | null {
  if (period === UNDATED) return null;
  if (period.startsWith(UNPARSEABLE_PREFIX)) {
    const sourceText = period.slice(UNPARSEABLE_PREFIX.length).trim();
    return sourceText ? `Undated — "${sourceText}"` : null;
  }
  return period;
}
