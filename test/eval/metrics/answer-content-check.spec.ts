import { answerContainsExpectedStrings } from '../../../eval/metrics/answer-content-check';

describe('answerContainsExpectedStrings', () => {
  it('should return true when every expected string appears in the answer text', () => {
    const result = answerContainsExpectedStrings(
      'The going-in cap rate is 5.25%, based on the comps spreadsheet.',
      ['5.25%'],
    );

    expect(result).toBe(true);
  });

  it('should return true only when every expected string appears, not just one of several', () => {
    const result = answerContainsExpectedStrings(
      'The valuation memo cites a cap rate of 6.10% for Northgate Business Park.',
      ['5.25%', '6.10%'],
    );

    expect(result).toBe(false);
  });

  it('should return false when an expected string is missing entirely', () => {
    const result = answerContainsExpectedStrings('The lease term is five years.', ['ten years']);

    expect(result).toBe(false);
  });

  it('should compare case-insensitively', () => {
    const result = answerContainsExpectedStrings('The lease term is TEN YEARS.', ['ten years']);

    expect(result).toBe(true);
  });

  it('should compare on whitespace-normalized text', () => {
    const result = answerContainsExpectedStrings('The   lease   term  is ten   years.', [
      'ten years',
    ]);

    expect(result).toBe(true);
  });

  it('should return true vacuously when no strings are expected', () => {
    const result = answerContainsExpectedStrings('Any answer text at all.', []);

    expect(result).toBe(true);
  });

  it("should not match '5%' inside '25%' — a short numeric expectation must not match a different number", () => {
    const result = answerContainsExpectedStrings('The vacancy rate held at 25% for the quarter.', [
      '5%',
    ]);

    expect(result).toBe(false);
  });

  it("should not match '4.1%' inside '14.1%'", () => {
    const result = answerContainsExpectedStrings('Vacancy rose to 14.1% year over year.', ['4.1%']);

    expect(result).toBe(false);
  });

  it('should match a numeric expectation cleanly bounded by non-digit characters', () => {
    const result = answerContainsExpectedStrings(
      'Industrial vacancy in the Meridian Corridor was 4.1% as of the market overview.',
      ['4.1%'],
    );

    expect(result).toBe(true);
  });

  it('should not match a numeric expectation flush against a following digit', () => {
    const result = answerContainsExpectedStrings('Building area totals 92,0001 square feet.', [
      '92,000',
    ]);

    expect(result).toBe(false);
  });

  it('should not match a numeric expectation flush against a preceding digit', () => {
    const result = answerContainsExpectedStrings('Building area totals 192,000 square feet.', [
      '92,000',
    ]);

    expect(result).toBe(false);
  });

  it('should still match non-numeric expectations as plain substrings, unaffected by the numeric boundary rule', () => {
    const result = answerContainsExpectedStrings(
      'Anchor tenant Vantage Fulfillment Co. leases the majority of the building.',
      ['Vantage Fulfillment Co.'],
    );

    expect(result).toBe(true);
  });
});
