import {
  modelVerifyClaimContractSchema,
  notSupportedOutcomeSchema,
  supportedOutcomeSchema,
} from '../../../../../src/features/evidence/qa/contracts/verify-claims.contract';

const buildCitation = (overrides: Partial<{ candidateIndex: number; quote: string }> = {}) => ({
  candidateIndex: 0,
  quote: 'Revenue grew 12% year over year.',
  ...overrides,
});

describe('notSupportedOutcomeSchema', () => {
  it('accepts { supported: false }', () => {
    expect(notSupportedOutcomeSchema.safeParse({ supported: false }).success).toBe(true);
  });

  it('rejects an unknown key alongside supported: false', () => {
    const result = notSupportedOutcomeSchema.safeParse({ supported: false, reason: 'no match' });

    expect(result.success).toBe(false);
  });
});

describe('supportedOutcomeSchema', () => {
  it('accepts supported: true with one citation', () => {
    const outcome = { supported: true, citations: [buildCitation()] };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('accepts supported: true with three citations', () => {
    const outcome = {
      supported: true,
      citations: [
        buildCitation({ candidateIndex: 0 }),
        buildCitation({ candidateIndex: 1 }),
        buildCitation({ candidateIndex: 2 }),
      ],
    };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('rejects zero citations', () => {
    const outcome = { supported: true, citations: [] };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects four citations', () => {
    const outcome = {
      supported: true,
      citations: [
        buildCitation({ candidateIndex: 0 }),
        buildCitation({ candidateIndex: 1 }),
        buildCitation({ candidateIndex: 2 }),
        buildCitation({ candidateIndex: 3 }),
      ],
    };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects a negative candidateIndex', () => {
    const outcome = { supported: true, citations: [buildCitation({ candidateIndex: -1 })] };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects a non-integer candidateIndex', () => {
    const outcome = { supported: true, citations: [buildCitation({ candidateIndex: 1.5 })] };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects a quote longer than 300 characters', () => {
    const outcome = { supported: true, citations: [buildCitation({ quote: 'x'.repeat(301) })] };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('accepts a quote at exactly the 300 character limit', () => {
    const outcome = { supported: true, citations: [buildCitation({ quote: 'x'.repeat(300) })] };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('rejects an unknown key on a citation', () => {
    const outcome = {
      supported: true,
      citations: [{ ...buildCitation(), chunkId: 'chunk-1' }],
    };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('rejects an unknown key on the outcome itself', () => {
    const outcome = { supported: true, citations: [buildCitation()], verdict: 'grounded' };

    expect(supportedOutcomeSchema.safeParse(outcome).success).toBe(false);
  });
});

describe('modelVerifyClaimContractSchema', () => {
  it('accepts a valid supported: false shape', () => {
    expect(modelVerifyClaimContractSchema.safeParse({ supported: false }).success).toBe(true);
  });

  it('accepts a valid supported: true shape', () => {
    const outcome = { supported: true, citations: [buildCitation()] };

    expect(modelVerifyClaimContractSchema.safeParse(outcome).success).toBe(true);
  });

  it('rejects a value outside the closed { supported } discriminant', () => {
    const outcome = { supported: 'maybe' };

    expect(modelVerifyClaimContractSchema.safeParse(outcome).success).toBe(false);
  });
});
