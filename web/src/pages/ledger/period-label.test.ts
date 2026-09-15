import { describe, expect, it } from 'vitest';
import { periodLabel } from './period-label';

describe('periodLabel', () => {
  it('returns a parsed period unchanged', () => {
    expect(periodLabel('2025-Q1')).toBe('2025-Q1');
    expect(periodLabel('2025')).toBe('2025');
  });

  it('has no display form for the bare undated sentinel', () => {
    expect(periodLabel('undated')).toBeNull();
  });

  it('shows the source text of a period the extractor could not read', () => {
    expect(periodLabel('undated:FY25ish')).toBe('Undated — "FY25ish"');
  });

  it('returns null when a prefixed key carries no source text', () => {
    expect(periodLabel('undated:')).toBeNull();
    expect(periodLabel('undated:   ')).toBeNull();
  });
});
