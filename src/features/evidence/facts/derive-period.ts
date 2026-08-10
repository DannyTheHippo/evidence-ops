/**
 * `FactKey.period` is the field most likely to silently break conflict grouping: two facts about
 * the same entity and metric only compare if their `period` strings are byte-identical, and a
 * spreadsheet almost always knows a transaction date to the day while a prose document only ever
 * states a month ("traded in March 2025") or nothing at all. Grouping at day granularity would
 * mean an xlsx fact and a prose fact about the very same sale never share a key.
 *
 * The fix is symmetric coarsening: every raw date-ish string, from either extractor, passes
 * through this one function before it becomes `FactKey.period`. It always resolves to the
 * coarsest granularity a reader could state (`YYYY-MM`, or `YYYY` if only a year is known), never
 * finer, so an xlsx cell's exact day and a memo's "March 2025" land on the same key.
 */
export const UNDATED_PERIOD = 'undated';

const ISO_DATE = /^(\d{4})-(\d{2})-\d{2}$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const YEAR_ONLY = /^(\d{4})$/;
const MONTH_YEAR = /\b([A-Za-z]+)\s+(\d{4})\b/;

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export function derivePeriodFromDateText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return UNDATED_PERIOD;
  }

  const isoDate = ISO_DATE.exec(trimmed);
  if (isoDate) {
    return `${isoDate[1]}-${isoDate[2]}`;
  }

  const isoMonth = ISO_MONTH.exec(trimmed);
  if (isoMonth) {
    return `${isoMonth[1]}-${isoMonth[2]}`;
  }

  const monthYear = MONTH_YEAR.exec(trimmed);
  if (monthYear) {
    const monthIndex = MONTH_NAMES.indexOf(monthYear[1].toLowerCase());
    if (monthIndex !== -1) {
      return `${monthYear[2]}-${String(monthIndex + 1).padStart(2, '0')}`;
    }
  }

  const yearOnly = YEAR_ONLY.exec(trimmed);
  if (yearOnly) {
    return yearOnly[1];
  }

  return UNDATED_PERIOD;
}
