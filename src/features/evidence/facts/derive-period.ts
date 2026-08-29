import { createHash } from 'node:crypto';
import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import { isRealCalendarDate } from './parse-calendar-date';

/**
 * `FactKey.period` is the field most likely to silently break conflict grouping: two facts about
 * the same entity and metric only compare if their `period` strings are byte-identical, and a
 * spreadsheet almost always knows a transaction date to the day while a prose document only ever
 * states a month ("traded in March 2025") or nothing at all. Grouping at day granularity would
 * mean an xlsx fact and a prose fact about the very same sale never share a key.
 *
 * Symmetric coarsening answers that: every raw date-ish string, from either extractor, passes
 * through {@link parsePeriod} before it becomes `FactKey.period`. A day resolves to its month, so
 * an xlsx cell's exact day and a memo's "March 2025" land on the same key.
 *
 * The key is the persisted form; {@link Period} is the comparable one. `parsePeriod` produces both
 * together and {@link parsePeriodKey} recovers the second from the first, so a caller holding only
 * a stored `FactKey.period` can still ask structural questions ("is this a month?", "does it
 * overlap the period this question named?") instead of comparing strings.
 */
export type PeriodGranularity =
  'month' | 'quarter' | 'year' | 'fiscal-year' | 'unstated' | 'unparseable';

/** Inclusive calendar bounds, both `YYYY-MM-DD`. Lexicographic string order is calendar order for
 * this form, which is what {@link periodsOverlap} compares on. */
export interface PeriodRange {
  readonly start: string;
  readonly end: string;
}

export interface Period {
  readonly granularity: PeriodGranularity;
  /** The `FactKey.period` form — the only part that is persisted, indexed, and grouped on. */
  readonly key: string;
  /** Absent for `fiscal-year` (a fiscal year's calendar bounds depend on a tenant fiscal calendar
   * this codebase does not model), `unstated`, and `unparseable`. {@link periodsOverlap} fails
   * CLOSED on an absent range — a period whose calendar bounds are unknown overlaps nothing,
   * because the alternative is guessing bounds and matching a period the text never named. */
  readonly range?: PeriodRange;
}

/** The key for a fact whose source stated no period at all. Shared on purpose: two documents that
 * each report a value with no period attached are making the same undated claim, and they must be
 * able to disagree with each other. A source that *did* state a period this module cannot read
 * gets {@link unparseablePeriodKey} instead, so a parser gap can never be mistaken for a source
 * that stayed silent. */
export const UNDATED_PERIOD = 'undated';

/** Prefix of every {@link unparseablePeriodKey}. Distinct from {@link UNDATED_PERIOD} by
 * construction: `undated` never contains `:`. */
export const UNPARSEABLE_PERIOD_PREFIX = 'undated:';

/** Bound on the readable portion of an {@link unparseablePeriodKey}. `groupKeyNormalized` is a
 * MongoDB index key (`migrations/0001-baseline.ts`), so an unbounded copy of
 * source text inside it could exceed the index key limit and fail the write. */
const UNPARSEABLE_TEXT_BUDGET = 64;

/** Years outside this window in free text are far more often an identifier — a suite number, a
 * part code — than a period, so a bare four-digit token is only read as a year inside it. Refusing
 * outside it costs a period that would have had to be stated as `YYYY-MM` to be trusted anyway. */
const MIN_PLAUSIBLE_YEAR = 1900;
const MAX_PLAUSIBLE_YEAR = 2099;

const MONTH_INDEX_BY_NAME = new Map<string, number>([
  ['january', 1],
  ['jan', 1],
  ['february', 2],
  ['feb', 2],
  ['march', 3],
  ['mar', 3],
  ['april', 4],
  ['apr', 4],
  ['may', 5],
  ['june', 6],
  ['jun', 6],
  ['july', 7],
  ['jul', 7],
  ['august', 8],
  ['aug', 8],
  ['september', 9],
  ['sept', 9],
  ['sep', 9],
  ['october', 10],
  ['oct', 10],
  ['november', 11],
  ['nov', 11],
  ['december', 12],
  ['dec', 12],
]);

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthPeriod(year: number, month: number): Period {
  const key = `${year}-${pad2(month)}`;
  return {
    granularity: 'month',
    key,
    range: { start: `${key}-01`, end: `${key}-${pad2(lastDayOfMonth(year, month))}` },
  };
}

function quarterPeriod(year: number, quarter: number): Period {
  const firstMonth = quarter * 3 - 2;
  const lastMonth = quarter * 3;
  return {
    granularity: 'quarter',
    key: `${year}-Q${quarter}`,
    range: {
      start: `${year}-${pad2(firstMonth)}-01`,
      end: `${year}-${pad2(lastMonth)}-${pad2(lastDayOfMonth(year, lastMonth))}`,
    },
  };
}

function yearPeriod(year: number): Period {
  return {
    granularity: 'year',
    key: String(year),
    range: { start: `${year}-01-01`, end: `${year}-12-31` },
  };
}

function fiscalYearPeriod(year: number): Period {
  return { granularity: 'fiscal-year', key: `FY${year}` };
}

function unstatedPeriod(): Period {
  return { granularity: 'unstated', key: UNDATED_PERIOD };
}

/**
 * A stable, per-text key for a source that stated a period this module refuses to read. Two
 * different unreadable texts ("sold in 2019", "sold in 2024") therefore key differently and can
 * never be reported as disagreeing with each other, and the key itself names the text that was
 * refused so the gap is visible in stored data rather than hidden behind a shared sentinel.
 *
 * Normalised through `normalizeEntityName` so the same text written with different case or
 * whitespace stays one key. Text longer than the index budget is truncated and disambiguated by a
 * digest of the whole normalised text, which keeps the key both bounded and collision-free.
 */
export function unparseablePeriodKey(text: string): string {
  const normalized = normalizeEntityName(text);
  if (normalized.length <= UNPARSEABLE_TEXT_BUDGET) {
    return `${UNPARSEABLE_PERIOD_PREFIX}${normalized}`;
  }
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${UNPARSEABLE_PERIOD_PREFIX}${normalized.slice(0, UNPARSEABLE_TEXT_BUDGET)}#${digest}`;
}

function unparseablePeriod(text: string): Period {
  return { granularity: 'unparseable', key: unparseablePeriodKey(text) };
}

/** `'refuse'` means the text matched this form's shape but is not a real calendar value, so the
 * span is consumed and yields nothing — a coarser matcher must not then read a period out of the
 * same characters. `undefined` means the text never was this form (a word that is not a month
 * name), leaving the span free for the matchers below. */
type MatchOutcome = Period | 'refuse' | undefined;

interface PeriodMatcher {
  readonly pattern: RegExp;
  resolve(match: RegExpExecArray): MatchOutcome;
}

function resolveMonthName(word: string): number | undefined {
  return MONTH_INDEX_BY_NAME.get(word.toLowerCase());
}

/**
 * Ordered most specific first: a later matcher never sees characters an earlier one consumed, so
 * `2025-03-14` yields one month rather than also a bare year, and `Q1 2025` yields one quarter
 * rather than also `2025`.
 */
const MATCHERS: readonly PeriodMatcher[] = [
  {
    pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (match) => {
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      return isRealCalendarDate(year, month, day) ? monthPeriod(year, month) : 'refuse';
    },
  },
  {
    pattern: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
    resolve: (match) => {
      const month = resolveMonthName(match[1]);
      if (month === undefined) {
        return undefined;
      }
      const [day, year] = [Number(match[2]), Number(match[3])];
      return isRealCalendarDate(year, month, day) ? monthPeriod(year, month) : 'refuse';
    },
  },
  {
    pattern: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g,
    resolve: (match) => {
      const month = resolveMonthName(match[2]);
      if (month === undefined) {
        return undefined;
      }
      const [day, year] = [Number(match[1]), Number(match[3])];
      return isRealCalendarDate(year, month, day) ? monthPeriod(year, month) : 'refuse';
    },
  },
  {
    pattern: /\b(\d{4})-(\d{2})\b/g,
    resolve: (match) => {
      const [year, month] = [Number(match[1]), Number(match[2])];
      return month >= 1 && month <= 12 ? monthPeriod(year, month) : 'refuse';
    },
  },
  {
    pattern: /\bQ([1-4])[-\s]?(\d{4})\b/gi,
    resolve: (match) => quarterPeriod(Number(match[2]), Number(match[1])),
  },
  {
    pattern: /\b(\d{4})[-\s]?Q([1-4])\b/gi,
    resolve: (match) => quarterPeriod(Number(match[1]), Number(match[2])),
  },
  {
    pattern: /\bFY[-\s]?(\d{4})\b/gi,
    resolve: (match) => fiscalYearPeriod(Number(match[1])),
  },
  {
    pattern: /\b([A-Za-z]{3,9})\.?[\s,]+(\d{4})\b/g,
    resolve: (match) => {
      const month = resolveMonthName(match[1]);
      return month === undefined ? undefined : monthPeriod(Number(match[2]), month);
    },
  },
];

/** Only ever appended to {@link MATCHERS} in sentence mode — see {@link findStatedPeriods}. */
const BARE_YEAR_MATCHER: PeriodMatcher = {
  pattern: /\b(\d{4})\b/g,
  resolve: (match) => {
    const year = Number(match[1]);
    return year >= MIN_PLAUSIBLE_YEAR && year <= MAX_PLAUSIBLE_YEAR
      ? yearPeriod(year)
      : /* not a period, not a refusal: a four-digit token outside the window is an identifier */
        undefined;
  },
};

const WHOLE_TEXT_YEAR = /^(\d{4})$/;

interface ConsumedSpan {
  readonly start: number;
  readonly end: number;
}

function runMatchers(text: string, matchers: readonly PeriodMatcher[]): Period[] {
  const consumed: ConsumedSpan[] = [];
  const found: Period[] = [];
  for (const matcher of matchers) {
    matcher.pattern.lastIndex = 0;
    for (;;) {
      const match = matcher.pattern.exec(text);
      if (!match) {
        break;
      }
      const span = { start: match.index, end: match.index + match[0].length };
      const overlapsConsumed = consumed.some(
        (other) => span.start < other.end && other.start < span.end,
      );
      if (overlapsConsumed) {
        continue;
      }
      const outcome = matcher.resolve(match);
      if (outcome === undefined) {
        continue;
      }
      consumed.push(span);
      if (outcome !== 'refuse') {
        found.push(outcome);
      }
    }
  }
  return found;
}

/**
 * The structured period a fact extractor's raw period text names, in *field* semantics: the value
 * is the whole of what the source offered, so a bare four-digit token is read as a year only when
 * it is the entire field. Inside running text a period is recognised only where a word token names
 * it (`March 2025`, `Q1 2025`, `FY2025`) or where it is written in full ISO form — which is why
 * `sold in 2019` is refused rather than coarsened to `2019`: the extractor handed over text it
 * could not reduce to a period, and guessing one out of a loose number is how a fact ends up keyed
 * to a period nobody stated.
 *
 * Never throws and never returns nothing: empty text is `unstated`, and text this module cannot
 * read is `unparseable` with a key naming the text ({@link unparseablePeriodKey}).
 */
export function parsePeriod(text: string): Period {
  const trimmed = text.trim();
  if (!trimmed) {
    return unstatedPeriod();
  }
  const [first] = runMatchers(trimmed, MATCHERS);
  if (first) {
    return first;
  }
  const wholeTextYear = WHOLE_TEXT_YEAR.exec(trimmed);
  if (wholeTextYear) {
    const year = Number(wholeTextYear[1]);
    if (year >= MIN_PLAUSIBLE_YEAR && year <= MAX_PLAUSIBLE_YEAR) {
      return yearPeriod(year);
    }
  }
  return unparseablePeriod(trimmed);
}

/** {@link parsePeriod}'s key, which is the form `FactKey.period` stores. Kept as its own function
 * because every fact extractor wants only the key. */
export function derivePeriodFromDateText(text: string): string {
  return parsePeriod(text).key;
}

/**
 * Every distinct period named anywhere in a sentence, in *sentence* semantics: unlike
 * {@link parsePeriod} a bare plausible year counts, because a question is prose in which `2019` is
 * a period reference rather than a field whose entire value happens to be a number. Returns the
 * periods in most-specific-first order with duplicates removed by key; an empty result means the
 * sentence named none.
 *
 * Callers decide what more than one means. A caller that must not act on the wrong period should
 * treat a result of any length other than one as "no period named" — naming two periods is not a
 * licence to pick either.
 */
export function findStatedPeriods(text: string): Period[] {
  const found = runMatchers(text.trim(), [...MATCHERS, BARE_YEAR_MATCHER]);
  const byKey = new Map<string, Period>();
  for (const period of found) {
    if (!byKey.has(period.key)) {
      byKey.set(period.key, period);
    }
  }
  return [...byKey.values()];
}

const KEY_FISCAL_YEAR = /^FY(\d{4})$/;
const KEY_QUARTER = /^(\d{4})-Q([1-4])$/;
const KEY_MONTH = /^(\d{4})-(\d{2})$/;
const KEY_YEAR = /^(\d{4})$/;

/**
 * Recovers a {@link Period} from a stored `FactKey.period`, so a consumer holding persisted data
 * can compare periods structurally without re-reading the source text.
 *
 * Fails CLOSED on a key it does not recognise — including any key written by an older or newer
 * form of this module — by returning `unparseable`, which carries no range and therefore overlaps
 * nothing ({@link periodsOverlap}). An unrecognised key must never be widened into a match.
 */
export function parsePeriodKey(key: string): Period {
  if (key === UNDATED_PERIOD) {
    return unstatedPeriod();
  }
  if (key.startsWith(UNPARSEABLE_PERIOD_PREFIX)) {
    return { granularity: 'unparseable', key };
  }
  const fiscalYear = KEY_FISCAL_YEAR.exec(key);
  if (fiscalYear) {
    return fiscalYearPeriod(Number(fiscalYear[1]));
  }
  const quarter = KEY_QUARTER.exec(key);
  if (quarter) {
    return quarterPeriod(Number(quarter[1]), Number(quarter[2]));
  }
  const month = KEY_MONTH.exec(key);
  if (month) {
    const monthNumber = Number(month[2]);
    if (monthNumber >= 1 && monthNumber <= 12) {
      return monthPeriod(Number(month[1]), monthNumber);
    }
  }
  const year = KEY_YEAR.exec(key);
  if (year) {
    return yearPeriod(Number(year[1]));
  }
  return { granularity: 'unparseable', key };
}

/**
 * Whether two periods cover any calendar day in common — the comparison a caller wants when
 * deciding whether a period a question named and a period a fact carries are about the same time.
 *
 * Fails CLOSED: a period with no calendar range (`fiscal-year`, `unstated`, `unparseable`)
 * overlaps nothing, including another period of the same kind. Two facts keyed `FY2025` still
 * group, because grouping compares keys; overlap is the looser question, and answering it `true`
 * from unknown bounds would attach a conflict to a period that was never shown to match.
 */
export function periodsOverlap(a: Period, b: Period): boolean {
  if (!a.range || !b.range) {
    return false;
  }
  return a.range.start <= b.range.end && b.range.start <= a.range.end;
}
