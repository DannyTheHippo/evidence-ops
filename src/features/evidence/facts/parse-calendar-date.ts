const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a `YYYY-MM-DD` string into a real `Date`, shared by every fact extractor that turns a
 * source-stated date into `FactCandidate.observedAt` (`xlsx-fact-extractor.ts`,
 * `prose-fact-extractor.ts`). `Date.UTC` plus a round-trip check catches a value the regex lets
 * through but the calendar does not — `2025-02-30` would otherwise silently roll forward to
 * March 2 instead of being treated as unparseable. Returns `undefined` for anything that is not a
 * complete, calendar-valid date: a month-only or year-only value, an empty string, or malformed
 * text — never guessed or coerced to the nearest real date.
 */
export function parseCalendarDate(text: string): Date | undefined {
  const match = FULL_DATE.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealCalendarDate =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return isRealCalendarDate ? date : undefined;
}
