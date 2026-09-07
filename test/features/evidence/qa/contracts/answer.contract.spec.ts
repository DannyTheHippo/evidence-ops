import type { EvidenceLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  answerContractSchema,
  citationSchema,
  claimSchema,
  locatorSchema,
  modelAnswerContractSchema,
  modelCitationSchema,
  modelInsufficientEvidenceOutcomeSchema,
  verificationReportSchema,
  type Locator,
} from '../../../../../src/features/evidence/qa/contracts/answer.contract';
import { toStructuredOutputFormat } from '../../../../../src/providers/model/structured-output-format.util';

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

const textBlockLocator: Locator = {
  kind: 'text-block',
  extractorVersion: 'text-extractor@1.0.0',
  blockIndex: 2,
  headingPath: [],
};

const pptxSlideLocator: Locator = {
  kind: 'pptx-slide',
  extractorVersion: 'pptx-extractor@1.0.0',
  slide: 4,
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
    ['text-block', textBlockLocator],
    ['pptx-slide', pptxSlideLocator],
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

describe('modelCitationSchema', () => {
  it('accepts a chunkId and quote with no docVersionId, sha256, or locator', () => {
    const citation = { chunkId: 'chunk-1', quote: 'Revenue grew 12% year over year.' };

    expect(modelCitationSchema.safeParse(citation).success).toBe(true);
  });

  it('rejects a citation missing chunkId', () => {
    const citation = { quote: 'Revenue grew 12% year over year.' };

    expect(modelCitationSchema.safeParse(citation).success).toBe(false);
  });

  it('rejects a quote longer than 300 characters, same bound as citationSchema', () => {
    const citation = { chunkId: 'chunk-1', quote: 'x'.repeat(301) };

    expect(modelCitationSchema.safeParse(citation).success).toBe(false);
  });
});

// ADR-0004 bound 4 (closed): the model may no longer author free text for `insufficient_evidence`
// or the `conflicting_evidence` outcome at all — see `modelInsufficientEvidenceOutcomeSchema` and
// `conflictingEvidenceOutcomeSchema`'s doc comments in `answer.contract.ts`.
describe('modelInsufficientEvidenceOutcomeSchema', () => {
  it('accepts a valid reasonCode', () => {
    const outcome = { kind: 'insufficient_evidence', reasonCode: 'no_relevant_evidence' };

    expect(modelInsufficientEvidenceOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('rejects a reasonCode outside the closed set', () => {
    const outcome = { kind: 'insufficient_evidence', reasonCode: 'EOPS_CANARY_XLSX_9F3B21' };

    expect(modelInsufficientEvidenceOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects the old free-text reason field with no reasonCode', () => {
    const outcome = { kind: 'insufficient_evidence', reason: 'the evidence does not mention this' };

    expect(modelInsufficientEvidenceOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('strips an accompanying free-text reason field rather than accepting or reporting it', () => {
    // Captures the exact exploit shape: a model that tries to smuggle a marker through a
    // leftover/forged `reason` alongside a valid `reasonCode` gets it silently dropped by zod's
    // default unknown-key stripping, not merely ignored by a consumer that reads `reasonCode`
    // instead — a caller stringifying the parsed value can never observe it either.
    const outcome = {
      kind: 'insufficient_evidence',
      reasonCode: 'no_relevant_evidence',
      reason: 'EOPS_CANARY_XLSX_9F3B21',
    };

    const result = modelInsufficientEvidenceOutcomeSchema.safeParse(outcome);

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.success && result.data)).not.toContain('EOPS_CANARY_XLSX_9F3B21');
  });
});

describe('modelAnswerContractSchema', () => {
  it('rejects a "conflicting_evidence" outcome — the model is never offered this branch', () => {
    const outcome = {
      kind: 'conflicting_evidence',
      factKey: { entity: 'Acme Corp', metric: 'revenue', period: 'Q3-2025' },
      values: [
        { value: 12_000_000, unit: 'usd', sourceChunkId: 'chunk-1' },
        { value: 12_500_000, unit: 'usd', sourceChunkId: 'chunk-2' },
      ],
    };

    expect(modelAnswerContractSchema.safeParse(outcome).success).toBe(false);
  });

  it('accepts an "insufficient_evidence" outcome with a valid reasonCode', () => {
    const outcome = {
      kind: 'insufficient_evidence',
      reasonCode: 'retrieved_evidence_contradicts_itself',
    };

    expect(modelAnswerContractSchema.safeParse(outcome).success).toBe(true);
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

  it('strips server-computed fields from a model-authored payload rather than accepting them', () => {
    // `claimCoverage` and `verificationReport` belong to `AnswerEnvelope`, computed by
    // `GroundingGateService` after the model call — they must never round-trip through the
    // schema the model's own structured output is validated against, or a model could author
    // its own (unverified) coverage number and have it accepted as the server's.
    const outcomeWithServerFields = {
      kind: 'answered',
      claims: [
        {
          statement: 'Revenue grew 12% year over year.',
          citations: [buildCitation(pdfPageLocator)],
        },
      ],
      claimCoverage: 1,
      verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
    };

    const result = answerContractSchema.safeParse(outcomeWithServerFields);

    expect(result.success).toBe(true);
    expect(
      result.success && (result.data as Record<string, unknown>).claimCoverage,
    ).toBeUndefined();
    expect(
      result.success && (result.data as Record<string, unknown>).verificationReport,
    ).toBeUndefined();
  });
});

describe('verificationReportSchema', () => {
  it('accepts a report with no atomization', () => {
    const report = { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] };

    expect(verificationReportSchema.safeParse(report).success).toBe(true);
  });

  it('accepts a report carrying an atomization summary', () => {
    const report = {
      verifiedClaimCount: 1,
      totalClaimCount: 1,
      droppedClaims: [],
      atomization: {
        decomposedClaimCount: 1,
        coverageFallbackCount: 0,
        atomDroppedClaimCount: 0,
        contradictionDroppedClaimCount: 0,
      },
    };

    expect(verificationReportSchema.safeParse(report).success).toBe(true);
  });

  it('rejects an atomization summary with a negative count', () => {
    const report = {
      verifiedClaimCount: 1,
      totalClaimCount: 1,
      droppedClaims: [],
      atomization: {
        decomposedClaimCount: -1,
        coverageFallbackCount: 0,
        atomDroppedClaimCount: 0,
        contradictionDroppedClaimCount: 0,
      },
    };

    expect(verificationReportSchema.safeParse(report).success).toBe(false);
  });
});

describe('answerContractSchema emitted as a structured-output JSON Schema', () => {
  // Regression test for a live 400 from Anthropic: `answerContractSchema` reuses `claimSchema`
  // and `citationSchema` (each referenced once, but through an array element, which zod's
  // `reused: 'ref'` mode still hoists) inside a `z.discriminatedUnion`. The SDK's own
  // `zodOutputFormat()` helper hardcodes `reused: 'ref'`, which produced `$defs`/`$ref` nested
  // under `anyOf` — Anthropic's structured-outputs API rejects that combination outright. See
  // `structured-output-format.util.ts` for the fix. This asserts the property the live API
  // actually enforces, since the API itself cannot be called from this test environment.
  const format = toStructuredOutputFormat(answerContractSchema);
  const serialized = JSON.stringify(format.schema);

  it('contains no $defs', () => {
    expect(serialized).not.toContain('$defs');
  });

  it('contains no $ref', () => {
    expect(serialized).not.toContain('$ref');
  });

  it('still expresses the three-way discriminated union via anyOf', () => {
    const anyOf = format.schema['anyOf'] as Array<Record<string, unknown>>;

    expect(Array.isArray(anyOf)).toBe(true);
    expect(anyOf).toHaveLength(3);
  });

  it('requires "kind" and "claims" on the answered branch, with no $ref standing in for the shape', () => {
    const anyOf = format.schema['anyOf'] as Array<Record<string, unknown>>;
    const answeredBranch = anyOf.find(
      (branch) =>
        (branch['properties'] as Record<string, unknown> | undefined)?.['kind'] !== undefined &&
        JSON.stringify(branch).includes('answered'),
    );

    expect(answeredBranch?.['required']).toEqual(['kind', 'claims']);
    expect((answeredBranch?.['properties'] as Record<string, unknown>)['claims']).toBeDefined();
  });
});

describe('modelAnswerContractSchema emitted as a structured-output JSON Schema', () => {
  // Regression test for the live incident this schema split fixes: `answerContractSchema`
  // required `docVersionId`/`sha256`/a structured `locator` on every citation, but the prompt
  // (`assemble-answer-messages.ts`) never shows the model any of those three — only `chunkId` and
  // a display-string `locator`. Every real answer's `sha256` failed `ModelSchemaValidationError`
  // because the model had no real value to report. `modelAnswerContractSchema` is what is now
  // actually sent to Anthropic (`SynthesisService.synthesizeAnswer`); this asserts it never asks
  // for what the prompt cannot supply.
  const format = toStructuredOutputFormat(modelAnswerContractSchema);
  const serialized = JSON.stringify(format.schema);

  it('never mentions sha256, docVersionId, or locator anywhere in the emitted schema', () => {
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('docVersionId');
    expect(serialized).not.toContain('locator');
  });

  it('requires only chunkId and quote on a citation within the answered branch', () => {
    const anyOf = format.schema['anyOf'] as Array<Record<string, unknown>>;
    const answeredBranch = anyOf.find(
      (branch) =>
        (branch['properties'] as Record<string, unknown> | undefined)?.['kind'] !== undefined &&
        JSON.stringify(branch).includes('answered'),
    );
    const claimsSchema = (answeredBranch?.['properties'] as Record<string, unknown>)[
      'claims'
    ] as Record<string, unknown>;
    const claimItemSchema = claimsSchema['items'] as Record<string, unknown>;
    const citationsSchema = (claimItemSchema['properties'] as Record<string, unknown>)[
      'citations'
    ] as Record<string, unknown>;
    const citationItemSchema = citationsSchema['items'] as Record<string, unknown>;

    expect(citationItemSchema['required']).toEqual(['chunkId', 'quote']);
    expect(Object.keys(citationItemSchema['properties'] as Record<string, unknown>).sort()).toEqual(
      ['chunkId', 'quote'],
    );
  });
});
