/** A list page's date-range filter key: `''` is Any time, `24h`/`7d`/`30d` are presets, and
 * `custom` uses the `from`/`to` calendar dates. */
export type DateRangeKey = '' | '24h' | '7d' | '30d' | 'custom';

/** A date-range filter as the URL holds it. `from` and `to` are local calendar dates
 * (`YYYY-MM-DD`) and are `''` unless `range` is `custom`. */
export interface DateRangeValue {
  range: DateRangeKey;
  from: string;
  to: string;
}

/** The range select's options, in display order. Each label names the span
 * `toDateRangeInstants` resolves for that key. */
export const DATE_RANGE_OPTIONS: readonly { value: DateRangeKey; label: string }[] = [
  { value: '', label: 'Any time' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESET_DAYS = { '7d': 7, '30d': 30 } as const;

/** Local midnight of a `YYYY-MM-DD` calendar date, or `undefined` when the string is not a real
 * calendar date. The round trip through `new Date(y, m - 1, d)` rejects a day or month the
 * constructor would otherwise roll over, such as `2026-02-30`. */
function parseCalendarDate(date: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const local = new Date(year, month, day);
  return local.getFullYear() === year && local.getMonth() === month && local.getDate() === day
    ? local
    : undefined;
}

/** True for `''` (unset) or a value `parseCalendarDate` accepts as a real calendar date; false for
 * any incomplete or invalid `type="date"` value, such as a year still being typed. `DateRange`
 * uses this to decide whether a keystroke is ready to leave its local draft and reach the URL. A
 * leading-zero year reads as still-typing rather than a real date: Chrome's date input reports
 * `0002`, `0020`, then `0202` while a four-digit year is entered, and `parseCalendarDate` would
 * otherwise accept the `100`–`999` stage. `parseCalendarDate` itself stays unchanged, so a
 * hand-edited link with a genuine sub-1000 year still reads. */
export function isCompleteDate(date: string): boolean {
  return date === '' || (!date.startsWith('0') && parseCalendarDate(date) !== undefined);
}

/** Reads the `range`, `from` and `to` URL params. A preset ignores the dates. A date that is not a
 * real calendar date reads as `''`. `custom`, or any other `range` alongside a valid date, reads
 * as custom; everything else reads as Any time. */
export function readDateRange(params: { range: string; from: string; to: string }): DateRangeValue {
  if (params.range === '24h' || params.range === '7d' || params.range === '30d') {
    return { range: params.range, from: '', to: '' };
  }
  const from = parseCalendarDate(params.from) ? params.from : '';
  const to = parseCalendarDate(params.to) ? params.to : '';
  if (params.range === 'custom' || from !== '' || to !== '') return { range: 'custom', from, to };
  return { range: '', from: '', to: '' };
}

/** The URL params for a date-range value: a preset writes `range` and clears both dates, custom
 * writes `range: 'custom'` with its dates, and Any time clears all three. */
export function writeDateRange(value: DateRangeValue): { range: string; from: string; to: string } {
  if (value.range === 'custom') return { range: 'custom', from: value.from, to: value.to };
  return { range: value.range, from: '', to: '' };
}

/** Resolves a date-range value to the ISO instants an API `createdAt` filter expects, with an
 * exclusive upper bound because the server filters with `$lt`.
 * - `24h` is rolling: `[now − 24 h, now)`.
 * - `7d` and `30d` are whole local days including today: from local midnight 6 or 29 days before
 *   today to local midnight tomorrow.
 * - Custom runs from local midnight of `from` to local midnight of the day after `to`, so a
 *   same-day range covers that whole day. An empty or invalid side is `undefined`. A `from` after
 *   `to` never reaches the API as an inverted pair: `to` drops, since `DateRange` already blocks
 *   this combination from reaching the URL through normal use and a hand-edited link is the only
 *   way to reach this branch.
 * - Any time is `{}`.
 * A malformed date never throws. Call it where the request is made: a `24h` result changes with
 * every call. */
export function toDateRangeInstants(
  value: DateRangeValue,
  now: Date = new Date(),
): { from?: string; to?: string } {
  switch (value.range) {
    case '24h':
      return { from: new Date(now.getTime() - DAY_MS).toISOString(), to: now.toISOString() };
    case '7d':
    case '30d': {
      const year = now.getFullYear();
      const month = now.getMonth();
      const day = now.getDate();
      return {
        from: new Date(year, month, day - (PRESET_DAYS[value.range] - 1)).toISOString(),
        to: new Date(year, month, day + 1).toISOString(),
      };
    }
    case 'custom': {
      const from = parseCalendarDate(value.from);
      const to = parseCalendarDate(value.to);
      const inverted = from !== undefined && to !== undefined && from.getTime() > to.getTime();
      return {
        from: from?.toISOString(),
        to:
          !inverted && to
            ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString()
            : undefined,
      };
    }
    default:
      return {};
  }
}

/** True when the value filters anything: a preset, or custom with at least one date. Any time and
 * an empty custom range are inactive. */
export function isDateRangeActive(value: DateRangeValue): boolean {
  if (value.range === 'custom') return value.from !== '' || value.to !== '';
  return value.range !== '';
}

/** The one way every list page keys its refetch trigger, `skip` reset and result announcement on
 * a date-range value: `''` while inactive, so revealing an empty Custom range changes nothing;
 * otherwise the canonical URL params, so two values that write the same params produce the same
 * key even if their object identity differs. */
export function dateRangeKey(value: DateRangeValue): string {
  return isDateRangeActive(value) ? JSON.stringify(writeDateRange(value)) : '';
}
