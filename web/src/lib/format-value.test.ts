import { describe, expect, it } from 'vitest';
import {
  formatCanonicalValue,
  formatMeasureValue,
  formatNumber,
  formatValue,
} from './format-value';

describe('formatNumber', () => {
  it('formats thousands with grouping separators', () => {
    expect(formatNumber(1_250_000)).toBe('1,250,000');
  });

  it('preserves every fractional digit the value carries', () => {
    expect(formatNumber(0.0085)).toBe('0.0085');
    expect(formatNumber(5.25)).toBe('5.25');
    expect(formatNumber(6.1)).toBe('6.1');
  });

  it('leaves values below 1000 byte-identical to String(value)', () => {
    const values = [0, 1, 6.1, 5.25, 0.0085, 999.5, -42.75];
    for (const value of values) {
      expect(formatNumber(value)).toBe(String(value));
    }
  });

  it('handles a negative grouped value', () => {
    expect(formatNumber(-1_250_000)).toBe('-1,250,000');
  });
});

describe('formatValue', () => {
  it('appends the unit token unchanged', () => {
    expect(formatValue(1_250_000, 'usd')).toBe('1,250,000 usd');
  });

  it('renders the number alone with no unit', () => {
    expect(formatValue(1_250_000)).toBe('1,250,000');
  });
});

describe('formatMeasureValue', () => {
  it('groups the amount and appends the unit', () => {
    expect(formatMeasureValue({ amount: 54_500_000, unit: 'usd' })).toBe('54,500,000 usd');
  });
});

describe('formatCanonicalValue', () => {
  it('formats the canonical amount when the value carries one', () => {
    expect(formatCanonicalValue({ amount: 6.1, unit: 'percent', canonicalAmount: 1_250_000 })).toBe(
      '1,250,000',
    );
  });

  it('appends the caller-supplied canonical unit, not the amount unit', () => {
    expect(
      formatCanonicalValue({ amount: 6.1, unit: 'percent', canonicalAmount: 0.061 }, 'ratio'),
    ).toBe('0.061 ratio');
  });

  it('returns undefined when the value carries no canonical amount, even with a unit given', () => {
    expect(formatCanonicalValue({ amount: 6.1, unit: 'percent' }, 'ratio')).toBeUndefined();
  });
});
