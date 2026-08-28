const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether `(year, month, day)` names a day the calendar actually has. The single calendar
 * authority on the fact path: {@link parseCalendarDate} and `derive-period.ts`'s date forms both
 * ask this one function, so a value one of them accepts cannot be a value the other rejects.
 * `Date.UTC` plus a round-trip check is what catches a value a regex lets through but the calendar
 * does not — `2025-02-30` would otherwise silently roll forward to March 2.
 */
export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Parses a `YYYY-MM-DD` string into a real `Date`, shared by every fact extractor that turns a
 * source-stated date into `FactCandidate.observedAt` (`xlsx-fact-extractor.ts`,
 * `prose-fact-extractor.ts`). Calendar validity is decided by {@link isRealCalendarDate}. Returns
 * `undefined` for anything that is not a complete, calendar-valid date: a month-only or year-only
 * value, an empty string, or malformed text — never guessed or coerced to the nearest real date.
 */
export function parseCalendarDate(text: string): Date | undefined {
  const match = FULL_DATE.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isRealCalendarDate(year, month, day)
    ? new Date(Date.UTC(year, month - 1, day))
    : undefined;
}
