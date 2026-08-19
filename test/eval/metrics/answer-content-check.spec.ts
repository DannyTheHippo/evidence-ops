import {
  answerContainsExpectedStrings,
  conflictValuesContainExpectedStrings,
} from '../../../eval/metrics/answer-content-check';

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

  it("should not match '3.5' inside '3.55' — a trailing decimal point followed by a digit still continues the number", () => {
    const result = answerContainsExpectedStrings('The multiplier was 3.55 for this comp.', ['3.5']);

    expect(result).toBe(false);
  });

  it("should not match '2,901,600' inside '2,901,6005' — a trailing comma-or-period rule must not let a longer digit run through", () => {
    const result = answerContainsExpectedStrings(
      'Net operating income was $2,901,6005 for the quarter.',
      ['2,901,600'],
    );

    expect(result).toBe(false);
  });

  it('should match a numeric expectation immediately followed by a sentence-ending period, not treat the period as continuing the number', () => {
    const result = answerContainsExpectedStrings(
      "According to the comps spreadsheet, Thornfield Industrial Park's net operating income is $2,901,600.",
      ['2,901,600'],
    );

    expect(result).toBe(true);
  });

  it('should match a numeric expectation immediately followed by a comma with no digit after it, not treat the comma as continuing the number', () => {
    const result = answerContainsExpectedStrings(
      'The net operating income was $2,901,600, according to the comps spreadsheet.',
      ['2,901,600'],
    );

    expect(result).toBe(true);
  });

  it('should still match non-numeric expectations as plain substrings, unaffected by the numeric boundary rule', () => {
    const result = answerContainsExpectedStrings(
      'Anchor tenant Vantage Fulfillment Co. leases the majority of the building.',
      ['Vantage Fulfillment Co.'],
    );

    expect(result).toBe(true);
  });

  it("should not match '5,' inside '5,200' — a comma-edged numeric needle must not fall back to plain containment", () => {
    const result = answerContainsExpectedStrings('The figure was 5,200 units.', ['5,']);

    expect(result).toBe(false);
  });

  it("should not match '5.' inside '5.25' — a period-edged numeric needle must not fall back to plain containment", () => {
    const result = answerContainsExpectedStrings('The rate is 5.25% today.', ['5.']);

    expect(result).toBe(false);
  });

  it("should not match '.5' inside '2.5' — a leading-period numeric needle must not fall back to plain containment", () => {
    const result = answerContainsExpectedStrings('The multiplier was 2.5 for this comp.', ['.5']);

    expect(result).toBe(false);
  });

  it("should not match ',000' inside '92,000' — a leading-comma numeric needle must not fall back to plain containment", () => {
    const result = answerContainsExpectedStrings('Area is 92,000 sf.', [',000']);

    expect(result).toBe(false);
  });

  it("should not match '5.25%' inside '15.25%'", () => {
    const result = answerContainsExpectedStrings('The going-in cap rate was 15.25% this quarter.', [
      '5.25%',
    ]);

    expect(result).toBe(false);
  });

  it("should not match '2,901,600' inside '$2,901,600,000'", () => {
    const result = answerContainsExpectedStrings(
      'Net operating income for the portfolio was $2,901,600,000 for the quarter.',
      ['2,901,600'],
    );

    expect(result).toBe(false);
  });
});

describe('conflictValuesContainExpectedStrings', () => {
  it("should match a percent-unit value against its document-rendered '%' form", () => {
    // con-001: comps.xlsx!F2 = 5.25% vs. valuation-memo.pdf page 2 = 6.10%.
    const result = conflictValuesContainExpectedStrings(
      [
        { value: 5.25, unit: 'percent' },
        { value: 6.1, unit: 'percent' },
      ],
      ['5.25%', '6.10%'],
    );

    expect(result).toBe(true);
  });

  it('should recover a trailing zero a JS number drops on parse', () => {
    // `Number('6.10')` is `6.1` — the plain and grouped forms alone can never produce '6.10%'.
    const result = conflictValuesContainExpectedStrings(
      [{ value: 6.1, unit: 'percent' }],
      ['6.10%'],
    );

    expect(result).toBe(true);
  });

  it('should match both a comma-grouped and an unformatted rendering of the same non-percent unit', () => {
    // con-006: comps.xlsx!G7 = $3,891,300 (formatted) vs. noi-summary.csv!C7 = 4150000 (unformatted).
    const result = conflictValuesContainExpectedStrings(
      [
        { value: 3_891_300, unit: 'usd' },
        { value: 4_150_000, unit: 'usd' },
      ],
      ['3,891,300', '4150000'],
    );

    expect(result).toBe(true);
  });

  it('should return false when an expected value was not among the attached values', () => {
    const result = conflictValuesContainExpectedStrings(
      [{ value: 5.25, unit: 'percent' }],
      ['5.25%', '6.10%'],
    );

    expect(result).toBe(false);
  });

  it('should not match a percent-suffixed expectation against a non-percent unit', () => {
    const result = conflictValuesContainExpectedStrings([{ value: 5.25, unit: 'usd' }], ['5.25%']);

    expect(result).toBe(false);
  });

  it('should return true vacuously when no strings are expected', () => {
    const result = conflictValuesContainExpectedStrings([{ value: 5.25, unit: 'percent' }], []);

    expect(result).toBe(true);
  });

  it('should not match a short numeric expectation flush against a longer, different number', () => {
    // Same numeric-boundary guarantee `answerContainsExpectedStrings` provides — '5%' must not
    // match inside the rendered '25%'.
    const result = conflictValuesContainExpectedStrings([{ value: 25, unit: 'percent' }], ['5%']);

    expect(result).toBe(false);
  });
});
