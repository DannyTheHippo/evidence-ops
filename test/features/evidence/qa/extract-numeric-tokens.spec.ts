import { extractNumericTokens } from '../../../../src/features/evidence/qa/extract-numeric-tokens';

describe('extractNumericTokens', () => {
  it('should extract a plain integer', () => {
    expect(extractNumericTokens('the lease term is 10 years')).toEqual([10]);
  });

  it('should extract a decimal percentage and strip the % sign', () => {
    expect(extractNumericTokens('a cap rate of 6.10%')).toEqual([6.1]);
  });

  it('should extract a dollar amount and strip the $ sign', () => {
    expect(extractNumericTokens('sold for $41000000')).toEqual([41_000_000]);
  });

  it('should extract a comma-grouped number as the same value as its ungrouped form', () => {
    expect(extractNumericTokens('the sale price was $12,500,000')).toEqual([12_500_000]);
    expect(extractNumericTokens('the sale price was $12500000')).toEqual([12_500_000]);
  });

  it('should parse "6.1" and "6.10" to the same numeric value', () => {
    // Motivates comparing parsed numbers instead of raw substrings: a naive
    // `chunkText.includes('6.1')` would match inside "6.10" coincidentally, and a naive
    // `chunkText.includes('6.10')` would miss a chunk that only ever writes "6.1" — parsing both
    // sides to numbers and comparing with `===` is correct in both directions.
    expect(extractNumericTokens('6.1')[0]).toBe(extractNumericTokens('6.10')[0]);
  });

  it('should extract multiple numbers from the same text in order', () => {
    expect(extractNumericTokens('revenue grew from 100 to 125 over 2 years')).toEqual([
      100, 125, 2,
    ]);
  });

  it('should return an empty array for text with no numbers', () => {
    expect(extractNumericTokens('Northgate Business Park traded last quarter')).toEqual([]);
  });

  it('should not parse a hyphenated span as a negative number', () => {
    // "2025-03" is a period, not "2025" minus "3" — negative-number parsing is deliberately not
    // supported (see the module's own comment) to avoid this misread.
    expect(extractNumericTokens('reported for period 2025-03')).toEqual([2025, 3]);
  });

  it('should not spell out words as numbers (known gap, documented)', () => {
    expect(extractNumericTokens('a six percent yield')).toEqual([]);
  });
});
