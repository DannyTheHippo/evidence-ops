import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  Citation,
  Claim,
} from '../../../../src/features/evidence/qa/contracts/answer.contract';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { VerifierMeasure } from '../../../../src/features/evidence/qa/types/verifier-measure.type';
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

  it.each([NaN, Infinity, -Infinity])(
    'should drop a claim whose only overlap with its quote is a shared number when the corroborating cell fact carries a non-finite amount (%s)',
    (nonFiniteAmount) => {
      // Same shape as the cell-fact-corroborated case above, but the stored fact's amount is
      // non-finite — an upstream extraction defect, not something this module can assume never
      // happens. The corroboration must not fire: the claim falls back to the same
      // "uncorroborated shared number" outcome it would get with no cell fact at all.
      const cellFact: GroundingCellFact = {
        chunkId: XLSX_CHUNK.chunkId,
        factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' },
        value: { amount: nonFiniteAmount, unit: 'usd' },
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

      expect(result.kind).toBe('dropped');
      if (result.kind !== 'dropped') throw new Error('unreachable');
      expect(result.violations[0].kind).toBe('quote-unrelated-to-statement');
    },
  );

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

  it('should drop a claim containing a full-width-digit number unsupported by any cited chunk or fact', () => {
    // A compatibility digit form ("１２２００") NFKC-folds to plain ASCII inside
    // `extractNumericTokens`, so it is checked — and rejected — exactly like its ASCII form.
    const claim = buildClaim({
      statement:
        'Northgate Business Park traded at a cap rate of approximately 6.10%, building area １２２００ SF.',
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('12200');
  });

  it('should drop a claim stating a number in a digit script NFKC cannot fold to ASCII (Arabic-Indic)', () => {
    // Regression for the non-ASCII-digit bypass: an Arabic-Indic digit run ("١٢٢٠٠") is legible to a
    // reader but this module has no value to parse it into — it must not extract as "no number
    // stated" and pass check 4 with nothing verified.
    const claim = buildClaim({
      statement:
        'Northgate Business Park traded at a cap rate of approximately 6.10%, building area ١٢٢٠٠ SF.',
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('cannot represent as a verifiable value');
  });

  it('should drop a claim stating a number past Number.MAX_SAFE_INTEGER, a magnitude this system cannot verify', () => {
    // The magnitude counterpart of the script case above: an 18-digit account number is legible to a
    // reader but `isRepresentableToken` rejects it, so `extractNumericTokens` omits it — it must not
    // extract as "no number stated" and pass check 4 with nothing verified.
    const claim = buildClaim({
      statement:
        'Northgate Business Park traded at a cap rate of approximately 6.10%, account 123456789012345678 was credited.',
    });

    const result = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('cannot represent as a verifiable value');
  });

  it('should survive a claim whose supported number is verified even though its cited chunk also carries an over-magnitude digit run', () => {
    // Asymmetry pinned for the magnitude case: an unrepresentable numeral appearing only in the
    // *chunk* text must not cost the claim a violation — it contributes no support (same as today) but
    // is not itself grounds to drop an otherwise fully-supported claim.
    const chunkWithOverMagnitudeDigits: RetrievedChunk = {
      chunkId: 'chunk-over-magnitude',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Northgate Business Park traded at a cap rate of approximately 6.10%. Account 123456789012345678 was credited.',
      locator: PDF_LOCATOR,
    };
    const claim = buildClaim({
      citations: [
        buildCitation({
          chunkId: chunkWithOverMagnitudeDigits.chunkId,
          quote: 'at a cap rate of approximately 6.10%',
        }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [chunkWithOverMagnitudeDigits],
      cellFacts: [],
    });

    expect(result.kind).toBe('survived');
  });

  it('should survive a claim whose supported number is verified even though its cited chunk also carries an unparseable digit run', () => {
    // Asymmetry pinned: an unparseable numeral appearing only in the *chunk* text must not cost the
    // claim a violation — it contributes no support (same as today) but is not itself grounds to drop
    // an otherwise fully-supported claim.
    const chunkWithForeignDigits: RetrievedChunk = {
      chunkId: 'chunk-arabic-digits',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Northgate Business Park traded at a cap rate of approximately 6.10%. المساحة ١٢٢٠٠ قدم مربع.',
      locator: PDF_LOCATOR,
    };
    const claim = buildClaim({
      citations: [
        buildCitation({
          chunkId: chunkWithForeignDigits.chunkId,
          quote: 'at a cap rate of approximately 6.10%',
        }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [chunkWithForeignDigits],
      cellFacts: [],
    });

    expect(result.kind).toBe('survived');
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

  it("should verify a claim stating a parenthesized negative number against a fact of the same negative amount, and upgrade its citation's locator", () => {
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-noi',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Northgate Business Park recorded NOI (USD) of ($41,000) for the period.',
      locator: XLSX_REGION_LOCATOR,
    };
    const cellFact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'noi', period: '2025-03' },
      value: { amount: -41_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'Northgate Business Park reported NOI of $(41,000) for the period.',
      citations: [
        buildCitation({ chunkId: chunk.chunkId, quote: chunk.text, locator: XLSX_REGION_LOCATOR }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [chunk], cellFacts: [cellFact] });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.claim.citations[0].locator).toEqual(XLSX_CELL_LOCATOR);
    expect(result.touchedFactKeys).toEqual([cellFact.factKey]);
  });

  it("should verify a claim citing a terse cell quote that is only a corroborated negative value, via checkQuoteAlignment's numeric-only alignment path", () => {
    // Same "terse cell quote" scenario `check-quote-alignment.ts`'s own doc comment describes for a
    // positive amount ("Sale Price (USD): 41000000"), exercised here with a negative one: the quote
    // shares almost no words with the statement, so alignment can only pass through the corroborated
    // numeric token `#-41000` — pinning that a negative value tags and compares the same way a
    // positive one does in that path, not just in `verifyClaim`'s own check 4.
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-noi-cell',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: '($41,000)',
      locator: XLSX_CELL_LOCATOR,
    };
    const cellFact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'noi', period: '2025-03' },
      value: { amount: -41_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'NOI was $(41,000) for the property this period.',
      citations: [
        buildCitation({ chunkId: chunk.chunkId, quote: chunk.text, locator: XLSX_CELL_LOCATOR }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [chunk], cellFacts: [cellFact] });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.touchedFactKeys).toEqual([cellFact.factKey]);
  });

  it('should drop a claim stating a negative number that contradicts a positive cell fact on the same cited chunk', () => {
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-noi-mismatch',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Northgate Business Park recorded NOI (USD) of ($41,000) for the period.',
      locator: XLSX_REGION_LOCATOR,
    };
    const cellFact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'noi', period: '2025-03' },
      value: { amount: 41_000, unit: 'usd' }, // positive — does not match the claim's negative figure
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'Northgate Business Park reported NOI of $(41,000) for the period.',
      citations: [
        buildCitation({ chunkId: chunk.chunkId, quote: chunk.text, locator: XLSX_REGION_LOCATOR }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [chunk], cellFacts: [cellFact] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('-41000');
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

  it('should drop a claim whose number genuinely differs from the cited chunk, even when both texts share the prototype-key word "constructor"', () => {
    // Regression for the `extract-numeric-tokens.ts` prototype-pollution defect: pre-fix, both
    // "five constructor bids" and "two constructor bids" extracted as `[NaN]` (`SCALES.constructor`
    // resolves through `Object.prototype` to the `Object` function, and arithmetic on it is `NaN`),
    // and `[NaN].includes(NaN)` is `true` under SameValueZero — so a claim stating a *different*
    // number than its cited chunk was laundered through as numerically supported. Post-fix both
    // sides extract their real, distinct values (5 and 2) and the mismatch is caught.
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-constructor',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'The site had two constructor bids submitted for the Northgate renovation.',
      locator: PDF_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'The site had five constructor bids submitted for the Northgate renovation.',
      citations: [
        buildCitation({ chunkId: chunk.chunkId, quote: chunk.text, locator: PDF_LOCATOR }),
      ],
    });

    const result = verifyClaim({ claim, retrievedChunks: [chunk], cellFacts: [] });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
    expect(result.dropped.reason).toContain('5');
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

describe('verifyClaim with subjectBinding', () => {
  const MERIDIAN_CELL_LOCATOR: EvidenceLocator = {
    kind: 'xlsx-cell',
    extractorVersion: 'v1',
    sheetName: 'Summary',
    cell: 'D9',
  };

  const SALE_PRICE_CHUNK: RetrievedChunk = {
    chunkId: 'chunk-sale-price',
    docVersionId: 'doc-v1',
    sha256: SHA256_A,
    text: 'Cedar Bluff Logistics Center reported a sale price of $41,000,000. Meridian Tower reported net operating income of $41,000,000.',
    locator: XLSX_REGION_LOCATOR,
  };

  const CEDAR_BLUFF_SALE_PRICE_FACT: GroundingCellFact = {
    chunkId: SALE_PRICE_CHUNK.chunkId,
    factKey: { entity: 'Cedar Bluff Logistics Center', metric: 'sale_price', period: '2025-03' },
    value: { amount: 41_000_000, unit: 'usd' },
    locator: XLSX_CELL_LOCATOR,
  };

  // A decoy fact for a different entity that happens to carry the exact same amount on the same
  // cited chunk — the ADR-0004 bound 3 residual gap this task closes.
  const MERIDIAN_NOI_FACT: GroundingCellFact = {
    chunkId: SALE_PRICE_CHUNK.chunkId,
    factKey: { entity: 'Meridian Tower', metric: 'net_operating_income', period: '2025-03' },
    value: { amount: 41_000_000, unit: 'usd' },
    locator: MERIDIAN_CELL_LOCATOR,
  };

  function buildCedarBluffClaim(): Claim {
    return buildClaim({
      statement: 'Cedar Bluff Logistics Center reported a sale price of $41,000,000.',
      citations: [
        buildCitation({
          chunkId: SALE_PRICE_CHUNK.chunkId,
          quote: 'Cedar Bluff Logistics Center reported a sale price of $41,000,000.',
          locator: XLSX_REGION_LOCATOR,
        }),
      ],
    });
  }

  it("should upgrade to the wrong entity's locator on a shared-value decoy fact when subjectBinding is off", () => {
    // Pins today's known gap (ADR-0004 bound 3) byte-identical: every existing caller omits
    // `subjectBinding`, so this must keep passing exactly as written.
    const result = verifyClaim({
      claim: buildCedarBluffClaim(),
      retrievedChunks: [SALE_PRICE_CHUNK],
      cellFacts: [MERIDIAN_NOI_FACT, CEDAR_BLUFF_SALE_PRICE_FACT],
    });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.claim.citations[0].locator).toEqual(MERIDIAN_CELL_LOCATOR);
  });

  it('should pick the entity-bound fact over a shared-value decoy when subjectBinding is on', () => {
    const result = verifyClaim({
      claim: buildCedarBluffClaim(),
      retrievedChunks: [SALE_PRICE_CHUNK],
      cellFacts: [MERIDIAN_NOI_FACT, CEDAR_BLUFF_SALE_PRICE_FACT],
      subjectBinding: true,
    });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.claim.citations[0].locator).toEqual(XLSX_CELL_LOCATOR);
    expect(result.touchedFactKeys).toEqual([CEDAR_BLUFF_SALE_PRICE_FACT.factKey]);
  });

  it("should drop a claim about one entity when the cited chunk only carries another entity's identically-valued fact, with subjectBinding on", () => {
    const result = verifyClaim({
      claim: buildCedarBluffClaim(),
      retrievedChunks: [SALE_PRICE_CHUNK],
      cellFacts: [MERIDIAN_NOI_FACT], // no fact for Cedar Bluff at all
      subjectBinding: true,
    });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
  });

  it("should reject a citation whose chunk never names the claim's subject entity, with subjectBinding on", () => {
    const unrelatedChunk: RetrievedChunk = {
      chunkId: 'chunk-unrelated',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Quarterly market report: overall vacancy trends improved region-wide.',
      locator: PDF_LOCATOR,
    };
    const cedarBluffAreaFact: GroundingCellFact = {
      chunkId: 'chunk-cedar-source',
      factKey: {
        entity: 'Cedar Bluff Logistics Center',
        metric: 'building_area_sf',
        period: '2025-03',
      },
      value: { amount: 412_000, unit: 'sf' },
      locator: XLSX_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement: 'Cedar Bluff Logistics Center has a building area of 412,000 SF.',
      citations: [
        buildCitation({
          chunkId: unrelatedChunk.chunkId,
          quote: 'overall vacancy trends improved region-wide',
          locator: PDF_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [unrelatedChunk],
      cellFacts: [cedarBluffAreaFact],
      subjectBinding: true,
    });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('quote-unrelated-to-statement');
    expect(result.dropped.reason).toContain(unrelatedChunk.chunkId);
    expect(result.dropped.reason).not.toContain('Cedar Bluff');
  });

  it('should stay inert with subjectBinding on when no cell fact names an entity the statement mentions', () => {
    const result = verifyClaim({
      claim: buildClaim(),
      retrievedChunks: [PROSE_CHUNK],
      cellFacts: [],
      subjectBinding: true,
    });

    expect(result.kind).toBe('survived');
  });

  it('should reject an entity-bound fact whose metric does not relate to the claim, with subjectBinding on', () => {
    const wrongMetricFact: GroundingCellFact = {
      chunkId: SALE_PRICE_CHUNK.chunkId,
      factKey: {
        entity: 'Cedar Bluff Logistics Center',
        metric: 'net_operating_income',
        period: '2025-03',
      },
      value: { amount: 41_000_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyClaim({
      claim: buildCedarBluffClaim(),
      retrievedChunks: [SALE_PRICE_CHUNK],
      cellFacts: [wrongMetricFact],
      subjectBinding: true,
    });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
  });

  it('should reject an entity- and metric-bound fact whose unit does not belong to that metric, with subjectBinding on', () => {
    const wrongUnitFact: GroundingCellFact = {
      chunkId: SALE_PRICE_CHUNK.chunkId,
      factKey: { entity: 'Cedar Bluff Logistics Center', metric: 'sale_price', period: '2025-03' },
      value: { amount: 41_000_000, unit: 'sf' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyClaim({
      claim: buildCedarBluffClaim(),
      retrievedChunks: [SALE_PRICE_CHUNK],
      cellFacts: [wrongUnitFact],
      subjectBinding: true,
    });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
  });
});

describe('verifyClaim with measures', () => {
  const SALE_PRICE_MEASURE: VerifierMeasure = {
    slug: 'sale_price',
    label: 'Sale Price',
    aliases: ['sale price'],
    valueType: 'currency',
    canonicalUnit: 'usd',
    units: [{ id: 'usd', toCanonicalFactor: 1 }],
    toleranceKind: 'relative',
    tolerance: 0.01,
  };
  const SALE_PRICE_CELL_LOCATOR: EvidenceLocator = {
    kind: 'xlsx-cell',
    extractorVersion: 'v1',
    sheetName: 'Comps',
    cell: 'B7',
  };
  const SALE_PRICE_REGION_LOCATOR: EvidenceLocator = {
    kind: 'xlsx-region',
    extractorVersion: 'v1',
    sheetName: 'Comps',
    range: 'A1:C10',
  };

  it('should survive a claim on the ADR-0024 c001 row and upgrade its citation locator to the sale_price cell, with measures supplied', () => {
    const statement = 'Northgate Business Park sold for $46,900,000.';
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-c001',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: statement,
      locator: SALE_PRICE_REGION_LOCATOR,
    };
    const cellFact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-07' },
      value: { amount: 46_900_000, unit: 'usd' },
      locator: SALE_PRICE_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement,
      citations: [
        buildCitation({
          chunkId: chunk.chunkId,
          quote: statement,
          locator: SALE_PRICE_REGION_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [chunk],
      cellFacts: [cellFact],
      measures: [SALE_PRICE_MEASURE],
      entities: [],
    });

    expect(result.kind).toBe('survived');
    if (result.kind !== 'survived') throw new Error('unreachable');
    expect(result.claim.citations[0].locator).toEqual(SALE_PRICE_CELL_LOCATOR);
    expect(result.touchedFactKeys).toEqual([cellFact.factKey]);
  });

  it('should refuse the raw-text fallback for a measure-bound number on a cell-fact chunk when the statement names no entity, with measures supplied', () => {
    // R4's asymmetry (`verify-structured-support.ts`): once a cited chunk carries any cell fact, a
    // measure-bound number never falls back to that chunk's raw text — not even when, as here, the
    // statement never names an entity `verifyStructuredSupport` could otherwise have bound the
    // number to, so nothing but the digit itself would otherwise support the claim.
    const statement = 'The property sold for $46,900,000.';
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-no-entity',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: statement,
      locator: SALE_PRICE_REGION_LOCATOR,
    };
    const cellFact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-07' },
      value: { amount: 46_900_000, unit: 'usd' },
      locator: SALE_PRICE_CELL_LOCATOR,
    };
    const claim = buildClaim({
      statement,
      citations: [
        buildCitation({
          chunkId: chunk.chunkId,
          quote: statement,
          locator: SALE_PRICE_REGION_LOCATOR,
        }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [chunk],
      cellFacts: [cellFact],
      measures: [SALE_PRICE_MEASURE],
      entities: [],
    });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
  });
});

describe('verifyClaim with atoms', () => {
  const SALE_PRICE_MEASURE: VerifierMeasure = {
    slug: 'sale_price',
    label: 'Sale Price',
    aliases: ['sale price'],
    valueType: 'currency',
    canonicalUnit: 'usd',
    units: [{ id: 'usd', toCanonicalFactor: 1 }],
    toleranceKind: 'relative',
    tolerance: 0.01,
  };
  const REGION_LOCATOR: EvidenceLocator = {
    kind: 'xlsx-region',
    extractorVersion: 'v1',
    sheetName: 'Comps',
    range: 'A1:C10',
  };

  it('should drop a claim whose atoms cover the statement when one atom is unsupported, with atom-unsupported', () => {
    // Splitting the claim strips the entity mention off the atom that states the number: the whole
    // statement survives (it names "Northgate Business Park" once, for the whole claim), but the
    // atom stating the number on its own names no entity, so `verifyStructuredSupport` cannot bind
    // it to the cell fact and R4 refuses the raw-text fallback (the same asymmetry the sibling
    // `verifyClaim with measures` describe block pins directly).
    const statement = 'Northgate Business Park closed a transaction. It sold for $46,900,000.';
    const atomWithEntity = 'Northgate Business Park closed a transaction';
    const atomWithNumber = 'It sold for $46,900,000';
    const chunk: RetrievedChunk = {
      chunkId: 'chunk-atoms',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: statement,
      locator: REGION_LOCATOR,
    };
    const cellFact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-07' },
      value: { amount: 46_900_000, unit: 'usd' },
      locator: REGION_LOCATOR,
    };
    const claim = buildClaim({
      statement,
      citations: [
        buildCitation({ chunkId: chunk.chunkId, quote: statement, locator: REGION_LOCATOR }),
      ],
    });

    const result = verifyClaim({
      claim,
      retrievedChunks: [chunk],
      cellFacts: [cellFact],
      measures: [SALE_PRICE_MEASURE],
      entities: [],
      atoms: [atomWithEntity, atomWithNumber],
    });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.violations[0].kind).toBe('atom-unsupported');
    expect(result.atomization).toEqual({ coverageFallback: false, atomDropped: true });
  });

  it('should drop a claim identically whether or not atoms are supplied, when the whole statement itself fails verification', () => {
    const claim = buildClaim({
      citations: [buildCitation({ chunkId: 'chunk-fabricated' })],
    });

    const withoutAtoms = verifyClaim({ claim, retrievedChunks: [PROSE_CHUNK], cellFacts: [] });
    const withAtoms = verifyClaim({
      claim,
      retrievedChunks: [PROSE_CHUNK],
      cellFacts: [],
      atoms: ['Northgate Business Park traded'],
    });

    expect(withAtoms.kind).toBe(withoutAtoms.kind);
    expect(withAtoms.violations).toEqual(withoutAtoms.violations);
    expect(withAtoms.touchedFactKeys).toEqual(withoutAtoms.touchedFactKeys);
    if (withAtoms.kind !== 'dropped' || withoutAtoms.kind !== 'dropped') {
      throw new Error('unreachable');
    }
    expect(withAtoms.dropped).toEqual(withoutAtoms.dropped);
  });
});
