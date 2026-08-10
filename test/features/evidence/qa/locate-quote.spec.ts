import { locateQuote } from '../../../../src/features/evidence/qa/locate-quote';

const CHUNK_TEXT =
  'Northgate Business Park traded in March 2025 at a cap rate of approximately 6.10%.';

describe('locateQuote', () => {
  it('should report an exact match when the quote is a verbatim substring of the chunk', () => {
    expect(locateQuote('at a cap rate of approximately 6.10%', CHUNK_TEXT)).toEqual({
      kind: 'exact',
      similarity: 1,
    });
  });

  it('should report an exact match when only a reflowed line break separates quote from chunk', () => {
    const reflowed = 'at a cap rate of\napproximately 6.10%';
    expect(locateQuote(reflowed, CHUNK_TEXT).kind).toBe('exact');
  });

  it('should report an exact match when the quote uses a straight quote and the chunk a curly one', () => {
    const chunkWithCurly = 'The tenant’s lease runs through 2030.';
    expect(locateQuote("The tenant's lease runs through 2030.", chunkWithCurly).kind).toBe('exact');
  });

  it('should flag a near-miss quote as fuzzy, not exact', () => {
    // One digit different from the source ("6.15%" vs the chunk's "6.10%") — close enough to be a
    // plausible transcription slip, but not verbatim.
    const nearMiss = 'at a cap rate of approximately 6.15%';
    const result = locateQuote(nearMiss, CHUNK_TEXT);

    expect(result.kind).toBe('fuzzy');
    expect(result.similarity).toBeGreaterThanOrEqual(0.85);
    expect(result.similarity).toBeLessThan(1);
  });

  it('should never report fuzzy as a passing kind', () => {
    const nearMiss = 'at a cap rate of approximately 6.15%';
    expect(locateQuote(nearMiss, CHUNK_TEXT).kind).not.toBe('exact');
  });

  it('should report none for a quote with no real relationship to the chunk text', () => {
    const result = locateQuote('The building was sold to a private equity fund.', CHUNK_TEXT);

    expect(result.kind).toBe('none');
    expect(result.similarity).toBeLessThan(0.85);
  });

  it('should report none for a paraphrase that is not a near-character-level match', () => {
    const paraphrase = 'the property changed hands at roughly a six percent yield';
    expect(locateQuote(paraphrase, CHUNK_TEXT).kind).toBe('none');
  });

  it('should report none when the quote normalizes to an empty string', () => {
    expect(locateQuote('   ', CHUNK_TEXT)).toEqual({ kind: 'none', similarity: 0 });
  });

  it('should locate a quote at the very start of the chunk', () => {
    expect(locateQuote('Northgate Business Park', CHUNK_TEXT).kind).toBe('exact');
  });

  it('should locate a quote at the very end of the chunk', () => {
    expect(locateQuote('approximately 6.10%.', CHUNK_TEXT).kind).toBe('exact');
  });
});
