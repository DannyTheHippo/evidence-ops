import type { EvidenceLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  answerContractSchema,
  citationSchema,
  claimSchema,
  locatorSchema,
  type Locator,
} from '../../../../../src/features/evidence/qa/contracts/answer.contract';

const SHA256_FIXTURE = 'a'.repeat(64);

const pdfPageLocator: Locator = {
  kind: 'pdf-page',
  extractorVersion: 'pdf-extractor@1.0.0',
  page: 3,
};

const docxParagraphLocator: Locator = {
  kind: 'docx-paragraph',
  extractorVersion: 'docx-extractor@1.0.0',
  paragraphIndex: 12,
  headingPath: ['Section 2', 'Subsection B'],
};

const xlsxRegionLocator: Locator = {
  kind: 'xlsx-region',
  extractorVersion: 'xlsx-extractor@1.0.0',
  sheetName: 'Q3 Revenue',
  range: 'A1:C10',
};

const xlsxCellLocator: Locator = {
  kind: 'xlsx-cell',
  extractorVersion: 'xlsx-extractor@1.0.0',
  sheetName: 'Q3 Revenue',
  cell: 'B7',
};

const buildCitation = (locator: Locator) => ({
  docVersionId: 'doc-version-1',
  sha256: SHA256_FIXTURE,
  chunkId: 'chunk-1',
  locator,
  quote: 'Revenue grew 12% year over year.',
});

describe('locatorSchema', () => {
  it.each([
    ['pdf-page', pdfPageLocator],
    ['docx-paragraph', docxParagraphLocator],
    ['xlsx-region', xlsxRegionLocator],
    ['xlsx-cell', xlsxCellLocator],
  ] as const)('accepts a valid %s locator', (_kind, locator) => {
    expect(locatorSchema.safeParse(locator).success).toBe(true);
  });

  it('rejects an unknown locator kind', () => {
    const result = locatorSchema.safeParse({ kind: 'csv-row', extractorVersion: '1.0.0' });

    expect(result.success).toBe(false);
  });

  it('keeps EvidenceLocator (database schema) and Locator (zod contract) structurally in sync', () => {
    // Compile-time-only assertions: if the two unions drift apart, one of these assignments
    // fails `tsc`, catching the drift before it reaches a citation nobody can verify.
    function assertAssignable<T>(_value: T): void {
      // no-op — the check happens at the type level, not at runtime.
    }

    const dbLocator = pdfPageLocator as EvidenceLocator;
    const contractLocator = pdfPageLocator satisfies Locator;

    assertAssignable<Locator>(dbLocator);
    assertAssignable<EvidenceLocator>(contractLocator);

    expect(true).toBe(true);
  });
});

describe('claimSchema', () => {
  it('accepts a claim with at least one citation', () => {
    const claim = {
      statement: 'Revenue grew 12% year over year.',
      citations: [buildCitation(pdfPageLocator)],
    };

    expect(claimSchema.safeParse(claim).success).toBe(true);
  });

  it('rejects a claim with zero citations', () => {
    const claim = { statement: 'Revenue grew 12% year over year.', citations: [] };

    expect(claimSchema.safeParse(claim).success).toBe(false);
  });
});

describe('citationSchema', () => {
  it('rejects a quote longer than 300 characters', () => {
    const citation = { ...buildCitation(pdfPageLocator), quote: 'x'.repeat(301) };

    expect(citationSchema.safeParse(citation).success).toBe(false);
  });

  it('accepts a quote at exactly the 300 character limit', () => {
    const citation = { ...buildCitation(pdfPageLocator), quote: 'x'.repeat(300) };

    expect(citationSchema.safeParse(citation).success).toBe(true);
  });
});

describe('answerContractSchema', () => {
  it('accepts a valid "answered" outcome', () => {
    const outcome = {
      kind: 'answered',
      claims: [
        {
          statement: 'Revenue grew 12% year over year.',
          citations: [buildCitation(xlsxCellLocator)],
        },
      ],
    };

    expect(answerContractSchema.safeParse(outcome).success).toBe(true);
  });

  it('accepts a valid "insufficient_evidence" outcome', () => {
    const outcome = {
      kind: 'insufficient_evidence',
      reason: 'No document in the corpus reports this metric for the requested period.',
    };

    expect(answerContractSchema.safeParse(outcome).success).toBe(true);
  });

  it('accepts a valid "conflicting_evidence" outcome', () => {
    const outcome = {
      kind: 'conflicting_evidence',
      factKey: { entity: 'Acme Corp', metric: 'revenue', period: 'Q3-2025' },
      values: [
        { value: 12_000_000, unit: 'usd', sourceChunkId: 'chunk-1' },
        { value: 12_500_000, unit: 'usd', sourceChunkId: 'chunk-2' },
      ],
    };

    expect(answerContractSchema.safeParse(outcome).success).toBe(true);
  });

  it('rejects an "answered" outcome containing a claim with zero citations', () => {
    const outcome = {
      kind: 'answered',
      claims: [{ statement: 'Revenue grew 12% year over year.', citations: [] }],
    };

    expect(answerContractSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects an "answered" outcome containing a citation quote over 300 characters', () => {
    const outcome = {
      kind: 'answered',
      claims: [
        {
          statement: 'Revenue grew 12% year over year.',
          citations: [{ ...buildCitation(pdfPageLocator), quote: 'x'.repeat(301) }],
        },
      ],
    };

    expect(answerContractSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects an unknown outcome kind', () => {
    const outcome = { kind: 'partially_answered', claims: [] };

    expect(answerContractSchema.safeParse(outcome).success).toBe(false);
  });
});
