import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DATE_RANGE_OPTIONS,
  dateRangeKey,
  isCompleteDate,
  isDateRangeActive,
  readDateRange,
  toDateRangeInstants,
  writeDateRange,
  type DateRangeKey,
} from './date-range';

const MALFORMED_DATES = ['garbage', '2026-13-01', '2026-9-1', '2026-02-30'];

function labelOf(range: DateRangeKey): string | undefined {
  return DATE_RANGE_OPTIONS.find((option) => option.value === range)?.label;
}

// Bounds are asserted as local date and time components, not ISO strings, so a bound computed in
// UTC reads as the wrong local hour on any host whose offset is not zero.
function localParts(instant: string | undefined): number[] {
  const date = new Date(instant!);
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()];
}

describe('readDateRange', () => {
  it.each(['24h', '7d', '30d'] as const)('reads %s as that preset, ignoring the dates', (range) => {
    expect(readDateRange({ range, from: '2026-06-01', to: '2026-06-02' })).toEqual({
      range,
      from: '',
      to: '',
    });
  });

  it('reads custom with its dates', () => {
    expect(readDateRange({ range: 'custom', from: '2026-06-01', to: '' })).toEqual({
      range: 'custom',
      from: '2026-06-01',
      to: '',
    });
    expect(readDateRange({ range: 'custom', from: '', to: '' })).toEqual({
      range: 'custom',
      from: '',
      to: '',
    });
  });

  it('reads a from or to without a range as custom', () => {
    expect(readDateRange({ range: '', from: '2026-06-01', to: '' })).toEqual({
      range: 'custom',
      from: '2026-06-01',
      to: '',
    });
    expect(readDateRange({ range: '', from: '', to: '2026-06-02' })).toEqual({
      range: 'custom',
      from: '',
      to: '2026-06-02',
    });
  });

  it('ignores an unknown range', () => {
    expect(readDateRange({ range: 'week', from: '', to: '' })).toEqual({
      range: '',
      from: '',
      to: '',
    });
    expect(readDateRange({ range: 'week', from: '2026-06-01', to: '' })).toEqual({
      range: 'custom',
      from: '2026-06-01',
      to: '',
    });
  });

  it('reads nothing set as Any time', () => {
    expect(readDateRange({ range: '', from: '', to: '' })).toEqual({ range: '', from: '', to: '' });
  });

  it.each(MALFORMED_DATES)('reads the malformed date %s as unset', (date) => {
    expect(readDateRange({ range: '', from: date, to: '' })).toEqual({
      range: '',
      from: '',
      to: '',
    });
    expect(readDateRange({ range: 'custom', from: '2026-06-01', to: date })).toEqual({
      range: 'custom',
      from: '2026-06-01',
      to: '',
    });
  });
});

describe('writeDateRange', () => {
  it('writes a preset and clears both dates', () => {
    expect(writeDateRange({ range: '7d', from: '2026-06-01', to: '2026-06-02' })).toEqual({
      range: '7d',
      from: '',
      to: '',
    });
  });

  it('writes custom with its dates', () => {
    expect(writeDateRange({ range: 'custom', from: '2026-06-01', to: '2026-06-02' })).toEqual({
      range: 'custom',
      from: '2026-06-01',
      to: '2026-06-02',
    });
  });

  it('clears all three for Any time', () => {
    expect(writeDateRange({ range: '', from: '2026-06-01', to: '' })).toEqual({
      range: '',
      from: '',
      to: '',
    });
  });
});

describe('toDateRangeInstants', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves Last 24 hours as the rolling 24 hours before now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 9, 30));

    const { from, to } = toDateRangeInstants({ range: '24h', from: '', to: '' });

    expect(labelOf('24h')).toBe('Last 24 hours');
    expect(localParts(from)).toEqual([2026, 5, 14, 9, 30]);
    expect(localParts(to)).toEqual([2026, 5, 15, 9, 30]);
    expect(new Date(to!).getTime() - new Date(from!).getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('resolves Last 7 days as seven whole local days including today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 9, 30));

    const { from, to } = toDateRangeInstants({ range: '7d', from: '', to: '' });

    expect(labelOf('7d')).toBe('Last 7 days');
    expect(localParts(from)).toEqual([2026, 5, 9, 0, 0]);
    expect(localParts(to)).toEqual([2026, 5, 16, 0, 0]);
  });

  it('resolves Last 30 days as thirty whole local days including today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 9, 30));

    const { from, to } = toDateRangeInstants({ range: '30d', from: '', to: '' });

    expect(labelOf('30d')).toBe('Last 30 days');
    expect(localParts(from)).toEqual([2026, 4, 17, 0, 0]);
    expect(localParts(to)).toEqual([2026, 5, 16, 0, 0]);
  });

  it('resolves a custom range to local midnight with an exclusive upper bound the day after the end date', () => {
    const { from, to } = toDateRangeInstants({
      range: 'custom',
      from: '2026-06-15',
      to: '2026-06-20',
    });

    expect(localParts(from)).toEqual([2026, 5, 15, 0, 0]);
    expect(localParts(to)).toEqual([2026, 5, 21, 0, 0]);
  });

  it('leaves a custom side undefined when its date is empty', () => {
    expect(
      toDateRangeInstants({ range: 'custom', from: '', to: '2026-06-15' }).from,
    ).toBeUndefined();
    expect(toDateRangeInstants({ range: 'custom', from: '2026-06-15', to: '' }).to).toBeUndefined();
  });

  it.each(MALFORMED_DATES)('leaves a custom side undefined for %s without throwing', (date) => {
    expect(toDateRangeInstants({ range: 'custom', from: date, to: date })).toEqual({
      from: undefined,
      to: undefined,
    });
  });

  it('resolves Any time to no bounds', () => {
    expect(toDateRangeInstants({ range: '', from: '', to: '' })).toEqual({});
  });

  it('drops an inverted custom range instead of sending to before from', () => {
    const { from, to } = toDateRangeInstants({
      range: 'custom',
      from: '2026-06-20',
      to: '2026-06-15',
    });

    expect(localParts(from)).toEqual([2026, 5, 20, 0, 0]);
    expect(to).toBeUndefined();
  });

  it('keeps equal from/to as a valid single-day range', () => {
    const { from, to } = toDateRangeInstants({
      range: 'custom',
      from: '2026-06-15',
      to: '2026-06-15',
    });

    expect(localParts(from)).toEqual([2026, 5, 15, 0, 0]);
    expect(localParts(to)).toEqual([2026, 5, 16, 0, 0]);
  });
});

describe('isDateRangeActive', () => {
  it('is inactive for Any time', () => {
    expect(isDateRangeActive({ range: '', from: '', to: '' })).toBe(false);
  });

  it('is active for a preset', () => {
    expect(isDateRangeActive({ range: '24h', from: '', to: '' })).toBe(true);
  });

  it('is inactive for an empty custom range', () => {
    expect(isDateRangeActive({ range: 'custom', from: '', to: '' })).toBe(false);
  });

  it('is active for a custom range with at least one date', () => {
    expect(isDateRangeActive({ range: 'custom', from: '', to: '2026-06-15' })).toBe(true);
  });
});

describe('isCompleteDate', () => {
  it('accepts an unset date', () => {
    expect(isCompleteDate('')).toBe(true);
  });

  it('accepts a real calendar date', () => {
    expect(isCompleteDate('2026-06-15')).toBe(true);
  });

  it.each(['0002-09-01', '0020-09-01', '0202-09-01', '2026-06-1', ...MALFORMED_DATES])(
    'rejects the intermediate or malformed value %s',
    (date) => {
      expect(isCompleteDate(date)).toBe(false);
    },
  );
});

describe('dateRangeKey', () => {
  it('is empty for Any time and for an empty custom range', () => {
    expect(dateRangeKey({ range: '', from: '', to: '' })).toBe('');
    expect(dateRangeKey({ range: 'custom', from: '', to: '' })).toBe('');
  });

  it('is the same key for two values that write the same params', () => {
    const a = { range: 'custom', from: '2026-06-01', to: '2026-06-02' } as const;
    const b = { range: 'custom', from: '2026-06-01', to: '2026-06-02' } as const;

    expect(dateRangeKey(a)).toBe(dateRangeKey(b));
    expect(dateRangeKey(a)).not.toBe('');
  });

  it('changes when the effective params change', () => {
    expect(dateRangeKey({ range: '24h', from: '', to: '' })).not.toBe(
      dateRangeKey({ range: '7d', from: '', to: '' }),
    );
  });
});
