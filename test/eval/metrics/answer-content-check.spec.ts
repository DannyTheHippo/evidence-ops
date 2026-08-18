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
});
