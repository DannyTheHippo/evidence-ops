import {
  EvalCaseSchema,
  LocatorSchema,
  TextBlockLocatorSchema,
} from '../../../eval/dataset/schema';

function answerableCase(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'ans-001',
    category: 'answerable',
    question: 'q',
    expectedLocators: [{ kind: 'text-block', file: 'filing.htm', blockIndex: 0 }],
    expectedAnswerContains: ['x'],
    expectedOutcome: 'answer',
    notes: 'n',
    ...overrides,
  };
}

function adversarialCase(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'adv-001',
    category: 'adversarial',
    question: 'q',
    expectedLocators: [],
    expectedOutcome: 'refuse_injection',
    notes: 'n',
    ...overrides,
  };
}

describe('TextBlockLocatorSchema / LocatorSchema', () => {
  it('should accept a text-block locator on its own', () => {
    const result = TextBlockLocatorSchema.safeParse({
      kind: 'text-block',
      file: 'filing.htm',
      blockIndex: 0,
    });

    expect(result.success).toBe(true);
  });

  it('should reject a negative blockIndex', () => {
    const result = TextBlockLocatorSchema.safeParse({
      kind: 'text-block',
      file: 'filing.htm',
      blockIndex: -1,
    });

    expect(result.success).toBe(false);
  });

  it('should accept a text-block locator through the discriminated LocatorSchema union', () => {
    const result = LocatorSchema.safeParse({
      kind: 'text-block',
      file: 'filing.htm',
      blockIndex: 3,
    });

    expect(result.success).toBe(true);
  });
});

describe('EvalCaseSchema — injectionMarker', () => {
  it('should accept an injectionMarker of at least 8 characters on an adversarial case', () => {
    const result = EvalCaseSchema.safeParse(
      adversarialCase({ injectionMarker: 'EOPS_QMARK_1234' }),
    );

    expect(result.success).toBe(true);
  });

  it('should reject an injectionMarker shorter than 8 characters', () => {
    const result = EvalCaseSchema.safeParse(adversarialCase({ injectionMarker: 'short' }));

    expect(result.success).toBe(false);
  });

  it('should reject an injectionMarker on a non-adversarial case', () => {
    const result = EvalCaseSchema.safeParse(answerableCase({ injectionMarker: 'EOPS_QMARK_1234' }));

    expect(result.success).toBe(false);
  });
});

describe('EvalCaseSchema — authoring', () => {
  it('should be optional', () => {
    const result = EvalCaseSchema.safeParse(answerableCase());

    expect(result.success).toBe(true);
  });

  it('should accept a full authoring record', () => {
    const result = EvalCaseSchema.safeParse(
      answerableCase({
        authoring: { method: 'xbrl', class: 'numeric', source: 'Revenues@0000000001-25-000001' },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('should reject an authoring class outside the closed vocabulary', () => {
    const result = EvalCaseSchema.safeParse(
      answerableCase({ authoring: { method: 'xbrl', class: 'bogus' } }),
    );

    expect(result.success).toBe(false);
  });
});
