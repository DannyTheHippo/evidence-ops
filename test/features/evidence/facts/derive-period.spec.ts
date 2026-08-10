import {
  derivePeriodFromDateText,
  UNDATED_PERIOD,
} from '../../../../src/features/evidence/facts/derive-period';

describe('derivePeriodFromDateText', () => {
  it('should coarsen a full ISO date to YYYY-MM', () => {
    expect(derivePeriodFromDateText('2025-03-14')).toBe('2025-03');
  });

  it('should pass an already-month-granular ISO string through unchanged', () => {
    expect(derivePeriodFromDateText('2025-03')).toBe('2025-03');
  });

  it('should parse a "Month YYYY" phrase to the same YYYY-MM a same-month ISO date would produce', () => {
    expect(derivePeriodFromDateText('March 2025')).toBe(derivePeriodFromDateText('2025-03-14'));
  });

  it('should parse a "Month YYYY" phrase embedded with surrounding words', () => {
    expect(derivePeriodFromDateText('closed in May 2025')).toBe('2025-05');
  });

  it('should be case-insensitive on the month name', () => {
    expect(derivePeriodFromDateText('march 2025')).toBe('2025-03');
    expect(derivePeriodFromDateText('MARCH 2025')).toBe('2025-03');
  });

  it('should fall back to the bare year when only a year is stated', () => {
    expect(derivePeriodFromDateText('2025')).toBe('2025');
  });

  it('should return the undated sentinel for an empty string', () => {
    expect(derivePeriodFromDateText('')).toBe(UNDATED_PERIOD);
    expect(derivePeriodFromDateText('   ')).toBe(UNDATED_PERIOD);
  });

  it('should return the undated sentinel for text with no recognizable date', () => {
    expect(derivePeriodFromDateText('at closing')).toBe(UNDATED_PERIOD);
  });

  it('should return the undated sentinel for an unrecognized month name', () => {
    expect(derivePeriodFromDateText('Smarch 2025')).toBe(UNDATED_PERIOD);
  });
});
