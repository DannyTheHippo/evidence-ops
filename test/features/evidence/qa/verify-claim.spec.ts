import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  Citation,
  Claim,
} from '../../../../src/features/evidence/qa/contracts/answer.contract';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import {
  verifyClaim,
  type GroundingCellFact,
} from '../../../../src/features/evidence/qa/verify-claim';

const SHA256_A = 'a'.repeat(64);

const PDF_LOCATOR: EvidenceLocator = { kind: 'pdf-page', extractorVersion: 'v1', page: 2 };
const XLSX_REGION_LOCATOR: EvidenceLocator = {
  kind: 'xlsx-region',
  extractorVersion: 'v1',
  sheetName: 'Summary',
  range: 'A1:C10',
};
const XLSX_CELL_LOCATOR: EvidenceLocator = {
  kind: 'xlsx-cell',
  extractorVersion: 'v1',
  sheetName: 'Summary',
  cell: 'B7',
};

const PROSE_CHUNK: RetrievedChunk = {
  chunkId: 'chunk-prose',
  docVersionId: 'doc-v1',
  sha256: SHA256_A,
  text: 'Northgate Business Park traded in March 2025 at a cap rate of approximately 6.10%.',
  locator: PDF_LOCATOR,
};

const XLSX_CHUNK: RetrievedChunk = {
  chunkId: 'chunk-xlsx',
  docVersionId: 'doc-v1',
  sha256: SHA256_A,
  text: 'Sale Price (USD): 41000000',
  locator: XLSX_REGION_LOCATOR,
};

const LEASE_CHUNK: RetrievedChunk = {
  chunkId: 'chunk-lease',
  docVersionId: 'doc-v1',
  sha256: SHA256_A,
  text: 'Tenant shall have the right to extend the Term for two (2) successive periods of five (5) years each.',
  locator: PDF_LOCATOR,
};

function buildCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    docVersionId: 'doc-v1',
    sha256: SHA256_A,
    chunkId: PROSE_CHUNK.chunkId,
    locator: PDF_LOCATOR,
    quote: 'at a cap rate of approximately 6.10%',
    ...overrides,
  };
}

function buildClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    statement: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
    citations: [buildCitation()],
    ...overrides,
  };
}

describe('verifyClaim', () => {
  it('should survive a claim whose citation is retrieved, provenance-matched, and quoted verbatim', () => {
    const result = verifyClaim({
      claim: buildClaim(),
      retrievedChunks: [PROSE_CHUNK],
      cellFacts: [],
    });

    expect(result.kind).toBe('survived');
    expect(result.violations).toEqual([]);
  });

  it('should drop a claim citing a chunkId that was never retrieved for this request', () => {
    const claim = buildClaim({
      citations: [buildCitation({ chunkId: 'chunk-fabricated' })],
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('chunk-not-retrieved');
    expect(result.dropped.reason).toContain('chunk-fabricated');
  });

  // `citation-provenance-mismatch` (a right-chunkId-but-fabricated-sha256/docVersionId citation)
  // no longer exists as a distinct failure mode: `docVersionId`/`sha256` are resolved server-side
  // from the same retrieved chunk this function looks `chunkId` up against
  // (`SynthesisService.resolveCitation`), so they can never disagree with it once the lookup
  // succeeds — see the `chunk-not-retrieved` case's comment in `verify-claim.ts` for why the
  // lookup alone is now the entire retrieval-containment check.

  it('should drop a claim whose quote does not appear in the cited chunk at all', () => {
    const claim = buildClaim({
      citations: [buildCitation({ quote: 'the building was demolished in 2019' })],
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('quote-not-found');
  });

  it('should drop a claim whose quote only fuzzily matches the cited chunk', () => {
    const claim = buildClaim({
      citations: [buildCitation({ quote: 'at a cap rate of approximately 6.15%' })],
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('quote-fuzzy-match');
    expect(result.dropped.reason).toContain('similarity');
  });

  it('should drop a claim citing a quote too thin to carry any content, even quoted verbatim', () => {
    // Regression for the missing alignment check: a citation quoting a single stopword passes
    // retrieval containment and verbatim quote containment trivially, and the statement here has no
    // digits for check 4 to catch either — quote alignment is the only check that can reject it.
    const thinQuote = 'the';
    const claim = buildClaim({
      statement: 'Northgate Business Park was renovated last year.',
      citations: [
        buildCitation({ chunkId: LEASE_CHUNK.chunkId, quote: thinQuote, locator: PDF_LOCATOR }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [LEASE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('quote-not-substantive');
    // The detail names the cited chunk, not the quote text — a violation detail travels all the way
    // to the `get_answer` MCP tool response, and corpus bytes must never reach it.
    expect(result.dropped.reason).toContain(LEASE_CHUNK.chunkId);
    expect(result.dropped.reason).not.toContain(thinQuote);
  });

  it('should drop a claim whose quote is substantive but shares no content with the statement', () => {
    const claim = buildClaim({
      statement: 'Northgate Business Park traded in March 2025.',
      citations: [
        buildCitation({
          chunkId: LEASE_CHUNK.chunkId,
          quote: LEASE_CHUNK.text,
          locator: PDF_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [LEASE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('quote-unrelated-to-statement');
  });

  it('should drop a claim whose only overlap with its quote is an uncorroborated shared number', () => {
    // Regression for the numeric-bypass laundering defect: a claim about an unrelated entity and
    // event shares nothing with its cited quote except a coincidental year, and no cell fact backs
    // that year on the cited chunk, so `checkQuoteAlignment` must not treat it as aligned.
    const claim = buildClaim({
      statement: 'Vantage Holdings was indicted for securities fraud in 2025.',
      citations: [
        buildCitation({
          chunkId: PROSE_CHUNK.chunkId,
          quote: 'Northgate Business Park traded in March 2025',
          locator: PDF_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('quote-unrelated-to-statement');
  });

  it('should survive a claim whose only overlap with its quote is a cell-fact-corroborated shared number', () => {
    const cellFact: GroundingCellFact = {
      chunkId: XLSX_CHUNK.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' },
      value: { amount: 41_000_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'Northgate Business Park sold for $41,000,000.',
      citations: [
        buildCitation({
          chunkId: XLSX_CHUNK.chunkId,
          quote: 'Sale Price (USD): 41000000',
          locator: XLSX_REGION_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [XLSX_CHUNK], cellFacts: [cellFact] });

    expect(result.kind).toBe('survived');
  });

  it('should survive a claim whose quote is a legitimate heavy paraphrase of its statement', () => {
    // Guards against the alignment floors being too aggressive: this statement and quote share
    // almost no surface tokens despite the quote clearly supporting the statement.
    const claim = buildClaim({
      statement: 'The lease includes two successive five-year renewal options.',
      citations: [
        buildCitation({
          chunkId: LEASE_CHUNK.chunkId,
          quote: LEASE_CHUNK.text,
          locator: PDF_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [LEASE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('survived');
  });

  it('should drop the whole claim when one of several citations fails, even if the rest verify', () => {
    const claim = buildClaim({
      citations: [buildCitation(), buildCitation({ chunkId: 'chunk-fabricated' })],
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
  });

  it('should drop a claim containing a number unsupported by any cited chunk or fact', () => {
    const claim = buildClaim({
      statement: 'Northgate Business Park traded at a cap rate of approximately 6.10%, up 45%.',
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('45');
  });

  it('should survive a numeric claim supported by the cited chunk text with no fact involved', () => {
    const claim = buildClaim({
      statement: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.claim.citations[0].locator).toEqual(PDF_LOCATOR);
  });

  it('should drop a claim with multiple numbers when only one is supported', () => {
    const claim = buildClaim({
      statement: 'The cap rate was approximately 6.10%, a 45% increase year over year.',
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
  });

  it("should upgrade a citation's locator to a supporting cell-level fact's locator", () => {
    const cellFact: GroundingCellFact = {
      chunkId: XLSX_CHUNK.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' },
      value: { amount: 41_000_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'The property sold for $41,000,000.',
      citations: [
        buildCitation({
          chunkId: XLSX_CHUNK.chunkId,
          quote: 'Sale Price (USD): 41000000',
          locator: XLSX_REGION_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [XLSX_CHUNK],
      cellFacts: [cellFact],
    });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.claim.citations[0].locator).toEqual(XLSX_CELL_LOCATOR);
    expect(result.claim.citations[0].locator).not.toEqual(XLSX_REGION_LOCATOR);
  });

  it('should reject a claim whose number appears in the chunk text but is not backed by any cell fact on a chunk that has cell facts', () => {
    // Regression for the grounding-gate wiring defect: a cited chunk that carries *any* cell-level
    // fact is authoritative for numbers, so an unmatched value is rejected rather than accepted on
    // a coincidental digit substring elsewhere in the chunk's raw text — proves check 4 no longer
    // silently degrades to digit-substring matching once cell facts are actually supplied. The quote
    // shares real words with the statement so check 3 (quote alignment) passes on word overlap alone,
    // isolating this as a check 4 failure rather than the number-corroboration check 3 also performs.
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-value-mismatch',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Northgate Business Park recorded a Sale Price (USD) of 41000000.',
      locator: XLSX_REGION_LOCATOR,
    };
    const cellFact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' },
      value: { amount: 99_000_000, unit: 'usd' }, // does not match the claimed number
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'Northgate Business Park sold for $41,000,000.',
      citations: [
        buildCitation({ chunkId: chunk.chunkId, quote: chunk.text, locator: XLSX_REGION_LOCATOR }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [chunk], cellFacts: [cellFact] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('41000000');
  });

  it('should return the fact key of a cellFact whose value matches a number the claim states', () => {
    const cellFact: GroundingCellFact = {
      chunkId: PROSE_CHUNK.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 6.1, unit: 'percent' },
      locator: PDF_LOCATOR,
    };

    const result = verifyClaim({
      claim: buildClaim(),
      retrievedChunks: [PROSE_CHUNK],
      cellFacts: [cellFact],
    });

    expect(result.kind).toBe('survived');
    expect(result.touchedFactKeys).toEqual([cellFact.factKey]);
  });

  it("should not touch an unrelated fact's key merely because it shares a cited chunk with a fact the claim actually states", () => {
    // Regression for the chunk-grain contamination bound (ADR-0004 bound 3): a comps-sheet chunk
    // holds many properties' facts at once, and a claim about one property must not inherit a
    // different property's conflict just because both facts were extracted from the same
    // row-window chunk. Fails on the pre-fix "every cellFact sharing a chunk" implementation,
    // which would have returned both fact keys here.
    const compsChunk: RetrievedChunk = {
      chunkId: 'chunk-comps',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Cedar Bluff Logistics Center reported a building area of 412,000 SF. Northgate Business Park traded at a cap rate of approximately 6.10%.',
      locator: XLSX_REGION_LOCATOR,
    };
    const cedarBluffFact: GroundingCellFact = {
      chunkId: compsChunk.chunkId,
      factKey: {
        entity: 'Cedar Bluff Logistics Center',
        metric: 'building_area',
        period: '2025-03',
      },
      value: { amount: 412_000, unit: 'sf' },
      locator: XLSX_CELL_LOCATOR,
    };
    const northgateFact: GroundingCellFact = {
      chunkId: compsChunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 6.1, unit: 'percent' },
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'Cedar Bluff Logistics Center has a building area of 412,000 SF.',
      citations: [
        buildCitation({
          chunkId: compsChunk.chunkId,
          quote: 'Cedar Bluff Logistics Center reported a building area of 412,000 SF.',
          locator: XLSX_REGION_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [compsChunk],
      cellFacts: [cedarBluffFact, northgateFact],
    });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.touchedFactKeys).toEqual([cedarBluffFact.factKey]);
    expect(result.touchedFactKeys).not.toContainEqual(northgateFact.factKey);
  });

  it('should return no touched fact keys for a dropped claim', () => {
    const claim = buildClaim({ citations: [buildCitation({ chunkId: 'chunk-fabricated' })] });
    const cellFact: GroundingCellFact = {
      chunkId: PROSE_CHUNK.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 6.1, unit: 'percent' },
      locator: PDF_LOCATOR,
    };

    const result = verifyClaim({
      claim,
      retrievedChunks: [PROSE_CHUNK],
      cellFacts: [cellFact],
    });

    expect(result.touchedFactKeys).toEqual([]);
  });
});
