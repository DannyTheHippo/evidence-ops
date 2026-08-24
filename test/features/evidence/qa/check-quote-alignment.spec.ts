import {
  checkQuoteAlignment,
  MIN_QUOTE_CONTENT_TOKENS,
  MIN_SHARED_CONTENT_TOKENS,
} from '../../../../src/features/evidence/qa/check-quote-alignment';

describe('checkQuoteAlignment', () => {
  it('should export the documented absolute floors', () => {
    expect(MIN_QUOTE_CONTENT_TOKENS).toBe(3);
    expect(MIN_SHARED_CONTENT_TOKENS).toBe(2);
  });

  it('should reject a quote below the content-token floor, even one appearing verbatim in the chunk', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park was renovated last year.',
      quotes: ['the'],
    });

    expect(result.kind).toBe('quote-not-substantive');
    if (result.kind !== 'quote-not-substantive') throw new Error('unreachable');
    expect(result.quoteIndex).toBe(0);
  });

  it('should reject the first quote below the floor when a claim cites more than one', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park was renovated last year.',
      quotes: ['Northgate Business Park was renovated.', 'and'],
    });

    expect(result.kind).toBe('quote-not-substantive');
    if (result.kind !== 'quote-not-substantive') throw new Error('unreachable');
    expect(result.quoteIndex).toBe(1);
  });

  it('should reject a substantive quote that shares nothing with the statement', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park traded in March 2025.',
      quotes: [
        'Tenant shall have the right to extend the Term for two (2) successive periods of five (5) years each.',
      ],
    });

    expect(result.kind).toBe('quote-unrelated-to-statement');
  });

  it('should reject a claim whose only overlap with its quote is an uncorroborated shared number', () => {
    // The year-laundering case: a claim about an entirely different entity and event shares nothing
    // with its quote except a coincidental year. No `corroboratedNumericTokens` is passed, matching a
    // claim with no cell fact backing that number on the cited chunk.
    const result = checkQuoteAlignment({
      statement: 'Vantage Holdings was indicted for securities fraud in 2025.',
      quotes: ['Northgate Business Park traded in March 2025.'],
    });

    expect(result.kind).toBe('quote-unrelated-to-statement');
  });

  it('should align a claim whose only overlap with a terse cell quote is a corroborated shared number', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park sold for $41,000,000.',
      quotes: ['Sale Price (USD): 41000000'],
      corroboratedNumericTokens: new Set([41_000_000]),
    });

    // The statement's words (northgate, business, park, sold) share nothing with the quote's
    // (sale, price, usd) — the only overlap is the number itself. A cell locator addresses a single
    // spreadsheet cell, so a cell quote is terse by construction; the shared number aligns it only
    // because it is corroborated by a cell fact of the same value on the cited chunk.
    expect(result.kind).toBe('aligned');
  });

  it("should reject a bare-number quote below the per-quote substance floor when the number is not corroborated, even matching the statement's number exactly", () => {
    const result = checkQuoteAlignment({
      statement: 'The property sold for $41,000,000.',
      quotes: ['41000000'],
    });

    // A lone numeric token is one content token, below MIN_QUOTE_CONTENT_TOKENS (3), and with no
    // corroborated numeric token to substitute for that content, the per-quote substance floor
    // rejects the quote before the overlap step ever runs.
    expect(result.kind).toBe('quote-not-substantive');
    if (result.kind !== 'quote-not-substantive') throw new Error('unreachable');
    expect(result.quoteIndex).toBe(0);
  });

  it('should accept a bare-number quote below the per-quote substance floor when the number is corroborated', () => {
    const result = checkQuoteAlignment({
      statement: 'The property sold for $41,000,000.',
      quotes: ['41000000'],
      corroboratedNumericTokens: new Set([41_000_000]),
    });

    // A terse cell quote that is only a value has no content tokens to spare, so a corroborated
    // numeric token stands in for substance directly, rather than being checked only at the overlap
    // step below.
    expect(result.kind).toBe('aligned');
  });

  it('should accept a claim whose numeric statement is directly supported by its quote', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
      quotes: ['at a cap rate of approximately 6.10%'],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should accept a legitimate heavy paraphrase sharing few surface tokens', () => {
    const result = checkQuoteAlignment({
      statement: 'The lease includes two successive five-year renewal options.',
      quotes: [
        'Tenant shall have the right to extend the Term for two (2) successive periods of five (5) years each.',
      ],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should align a claim sharing a word token and a corroborated numeric token with its quote', () => {
    const result = checkQuoteAlignment({
      statement: 'The sale amount recorded was $41,000,000.',
      quotes: ['Sale Price (USD): 41000000'],
      corroboratedNumericTokens: new Set([41_000_000]),
    });

    // "sale" (a word token) is shared once — below MIN_SHARED_CONTENT_TOKENS (2) on its own, since an
    // uncorroborated number never pools with a word count toward that floor — but the corroborated
    // number 41000000 clears the overlap gate independently.
    expect(result.kind).toBe('aligned');
  });

  it('should reject a claim sharing a word token and an uncorroborated numeric token with its quote', () => {
    const result = checkQuoteAlignment({
      statement: 'The sale amount recorded was $41,000,000.',
      quotes: ['Sale Price (USD): 41000000'],
    });

    // Same shared word ("sale") and shared number as above, but with no corroboration: the shared
    // number no longer pools with the single shared word to reach MIN_SHARED_CONTENT_TOKENS.
    expect(result.kind).toBe('quote-unrelated-to-statement');
  });

  it('should align a claim and quote in Cyrillic sharing enough word tokens, rather than erasing them', () => {
    const result = checkQuoteAlignment({
      statement: 'Северный Бизнес Парк был продан за сорок один миллион долларов.',
      quotes: ['Северный Бизнес Парк был продан в марте.'],
    });

    // Before Unicode-aware splitting, every character here falls outside `[^a-z0-9]+`'s complement,
    // so both statement and quote would tokenize to nothing, fail the substance floor at zero
    // content tokens, and could never align regardless of what they say. Splitting on `\p{L}`/`\p{N}`
    // extracts the real words, and "северный", "бизнес", "парк", "был", "продан" are shared,
    // clearing MIN_SHARED_CONTENT_TOKENS on word overlap alone — no numeric corroboration involved.
    expect(result.kind).toBe('aligned');
  });

  it('should pool content tokens across multiple quotes on the same claim', () => {
    const result = checkQuoteAlignment({
      statement: 'The lease includes two successive five-year renewal options.',
      quotes: ['two (2) successive periods', 'of five (5) years each'],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should ignore stopwords and sub-length tokens when counting content', () => {
    const result = checkQuoteAlignment({
      statement:
        'The and for that with this from was were have shall each are its into upon such any all may can.',
      quotes: ['The and for that with.'],
    });

    expect(result.kind).toBe('quote-not-substantive');
  });
});
