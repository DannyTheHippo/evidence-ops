import {
  resolveConflictPolicy,
  type ConflictingFactForResolution,
  type ResolveConflictProposal,
  type SurvivorshipPolicy,
} from '../../../../src/features/evidence/conflicts/resolve-conflict-policy';

function fact(overrides: Partial<ConflictingFactForResolution> = {}): ConflictingFactForResolution {
  return {
    id: 'fact-id',
    sourceClass: 'crm-export',
    ...overrides,
  };
}

// Narrows the discriminated union so callers get a typed `proposedWinnerFactId` back, rather than
// every assertion having to re-check `ruleFired !== 'none'` inline.
function expectWinner(
  result: ResolveConflictProposal,
  ruleFired: 'authority' | 'recency',
  factId: string,
): void {
  if (result.ruleFired === 'none') {
    throw new Error(
      `expected rule '${ruleFired}' to fire with a winner, got 'none': ${result.explanation}`,
    );
  }
  expect(result.ruleFired).toBe(ruleFired);
  expect(result.proposedWinnerFactId).toBe(factId);
}

function expectNone(result: ResolveConflictProposal): void {
  expect(result.ruleFired).toBe('none');
  expect('proposedWinnerFactId' in result).toBe(false);
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('resolveConflictPolicy', () => {
  it('should return none when fewer than two candidates are supplied', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export'],
      stalenessWindowMs: DAY_MS,
    };

    const result = resolveConflictPolicy([fact({ id: 'a' })], policy);

    expectNone(result);
    expect(result.explanation).toContain('Fewer than two candidates');
  });

  it('should return none when no authorityOrder is configured for the metric', () => {
    const facts = [
      fact({ id: 'a', sourceClass: 'crm-export' }),
      fact({ id: 'b', sourceClass: 'memo' }),
    ];

    const missing = resolveConflictPolicy(facts, { stalenessWindowMs: DAY_MS });
    expectNone(missing);
    expect(missing.explanation).toContain('No authorityOrder');

    const empty = resolveConflictPolicy(facts, { authorityOrder: [], stalenessWindowMs: DAY_MS });
    expectNone(empty);
    expect(empty.explanation).toContain('No authorityOrder');
  });

  // The negative control: a naive `indexOf`/rank lookup would happily resolve this — the
  // 'crm-export' fact would find rank 0 and win, ignoring that the order also claims 'crm-export'
  // is rank 2. A configuration that assigns one source class two different ranks has no coherent
  // answer to "which rank does crm-export have", so the policy must decline rather than pick
  // whichever occurrence a lookup happens to find first.
  it('should return none, not a confident guess, when authorityOrder assigns the same class two ranks', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo', 'crm-export'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({ id: 'crm-fact', sourceClass: 'crm-export' }),
      fact({ id: 'memo-fact', sourceClass: 'memo' }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain('contradictory');
    expect(result.explanation).toContain('crm-export');
  });

  it('should return none when a candidate is unclassified, even if the order explicitly lists it', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['unclassified', 'crm-export'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({ id: 'unclassified-fact', sourceClass: 'unclassified' }),
      fact({ id: 'crm-fact', sourceClass: 'crm-export' }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain('unclassified');
  });

  it('should return none when a candidate source class is absent from the configured order', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({ id: 'crm-fact', sourceClass: 'crm-export' }),
      fact({ id: 'report-fact', sourceClass: 'report' }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain("'report'");
  });

  it('should propose the higher-authority fact when ranks differ (authority rule)', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'pm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({ id: 'crm-fact', sourceClass: 'crm-export' }),
      fact({ id: 'memo-fact', sourceClass: 'memo' }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectWinner(result, 'authority', 'crm-fact');
    expect(result.explanation).toContain('crm-fact');
  });

  it('should return none on an authority tie when a tied candidate has no observedAt', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({ id: 'a', sourceClass: 'crm-export', observedAt: new Date('2026-01-01') }),
      fact({ id: 'b', sourceClass: 'crm-export' }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain('no observedAt');
  });

  it('should not let a missing observedAt on a lower-ranked, non-tied loser block an authority win', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({ id: 'crm-fact', sourceClass: 'crm-export', observedAt: new Date('2026-01-01') }),
      fact({ id: 'memo-fact', sourceClass: 'memo' }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectWinner(result, 'authority', 'crm-fact');
  });

  it('should return none on an authority tie when the tied observedAt values are identical', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const same = new Date('2026-01-01T00:00:00.000Z');
    const facts = [
      fact({ id: 'a', sourceClass: 'crm-export', observedAt: same }),
      fact({ id: 'b', sourceClass: 'crm-export', observedAt: new Date(same) }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain('staleness window');
  });

  it('should return none on an authority tie when the recency gap does not exceed the staleness window', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({
        id: 'older',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      fact({
        id: 'newer',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-02T00:00:00.000Z'), // exactly one day ahead — the boundary
      }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain('staleness window');
  });

  it('should propose the fresher fact when an authority tie clears the staleness window (recency rule)', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({
        id: 'older',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      fact({
        id: 'newer',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-02T00:00:00.001Z'), // one millisecond past the boundary
      }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectWinner(result, 'recency', 'newer');
  });

  it('should explain that recency never breaks ties when the metric has no configured staleness window', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: Number.POSITIVE_INFINITY,
    };
    const facts = [
      fact({
        id: 'older',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      fact({
        id: 'newer',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain('no staleness window');
    expect(result.explanation).not.toContain('Infinity');
  });

  it('should return none, not a NaN-driven winner, when a tied candidate has an Invalid Date observedAt', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({
        id: 'valid-date',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      fact({ id: 'invalid-date', sourceClass: 'crm-export', observedAt: new Date('not-a-date') }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectNone(result);
    expect(result.explanation).toContain('invalid');
  });

  it('should break a three-way authority tie by the closest gap, not the widest', () => {
    const policy: SurvivorshipPolicy = {
      authorityOrder: ['crm-export', 'memo'],
      stalenessWindowMs: DAY_MS,
    };
    const facts = [
      fact({
        id: 'oldest',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      fact({
        id: 'middle',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      fact({
        id: 'freshest',
        sourceClass: 'crm-export',
        observedAt: new Date('2026-01-10T00:00:00.000Z'),
      }),
    ];

    const result = resolveConflictPolicy(facts, policy);

    expectWinner(result, 'recency', 'freshest');
  });
});
