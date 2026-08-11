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
    // a coincidental digit substring elsewhere in the chunk's raw text — proves check 3 no longer
    // silently degrades to digit-substring matching once cell facts are actually supplied.
    const cellFact: GroundingCellFact = {
      chunkId: XLSX_CHUNK.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' },
      value: { amount: 99_000_000, unit: 'usd' }, // does not match the claimed number
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

    const result = verifyClaim({ claim, retrievedChunks: [XLSX_CHUNK], cellFacts: [cellFact] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('41000000');
  });

  it('should return the fact keys of every cellFact sharing a chunk with a surviving claim', () => {
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
