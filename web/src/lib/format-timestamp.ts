const RELATIVE_UNITS: ReadonlyArray<[unit: Intl.RelativeTimeFormatUnit, unitMs: number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const absoluteFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

// Every reader of these two functions is display code reached from a list page built off
// whatever the API returned — an empty or malformed timestamp must render something, not throw
// and take the row (or the page, for an unhandled render error) down with it. '—' is this app's
// existing "no value to show" convention (see AnswersPage's claim-coverage cell).
const INVALID_TIMESTAMP = '—';

function toValidDate(iso: string): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Short human phrase for an ISO timestamp relative to `now` ("2 hours ago", "yesterday", "in 3
 * days"), picking the coarsest unit the difference clears rather than always reporting seconds.
 * `now` defaults to the current time and exists so a caller — namely this function's own test —
 * can pass a fixed instant instead of stubbing the global clock. Returns '—' for an invalid or
 * empty `iso`.
 */
export function formatRelativeTimestamp(iso: string, now: Date = new Date()): string {
  const date = toValidDate(iso);
  if (!date) return INVALID_TIMESTAMP;

  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);

  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (absDiffMs < unitMs) continue;
    return relativeFormat.format(Math.round(diffMs / unitMs), unit);
  }
  return relativeFormat.format(Math.round(diffMs / 1000), 'second');
}

/**
 * Full unambiguous local timestamp for an ISO string, meant for a `title` attribute or copied
 * text where the relative phrase above is too vague to trust. Returns '—' for an invalid or
 * empty `iso`, matching `formatRelativeTimestamp`'s fallback rather than rendering "Invalid Date".
 */
export function formatAbsoluteTimestamp(iso: string): string {
  const date = toValidDate(iso);
  return date ? absoluteFormat.format(date) : INVALID_TIMESTAMP;
}
