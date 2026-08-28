import {
  aggregateVariance,
  citationSetKey,
  type VarianceObservation,
} from '../../../eval/variance/aggregate-variance';
import type { CaseOutcomeKind } from '../../../eval/metrics/compute-metrics';

interface ObservationOverrides {
  readonly outcomeKind?: CaseOutcomeKind;
  readonly citedChunkIds?: readonly string[];
  readonly claimCount?: number;
}

function observation(
  caseId: string,
  runIndex: number,
  overrides: ObservationOverrides = {},
): VarianceObservation {
  return {
    caseId,
    runIndex,
    outcomeKind: overrides.outcomeKind ?? 'answered',
    citedChunkIds: overrides.citedChunkIds ?? ['chunk-a'],
    claimCount: overrides.claimCount ?? 1,
  };
}

/** Same question, same result on every pass — the shape everything else is compared against. */
function stableCase(caseId: string, runCount: number): VarianceObservation[] {
  return Array.from({ length: runCount }, (_unused, index) => observation(caseId, index + 1));
}

describe('citationSetKey', () => {
  it('should order the cited chunk ids so citation order does not change the key', () => {
    expect(citationSetKey(['chunk-b', 'chunk-a'])).toBe(citationSetKey(['chunk-a', 'chunk-b']));
  });

  it('should dedupe repeated chunk ids so two claims citing one chunk match one claim citing it', () => {
    expect(citationSetKey(['chunk-a', 'chunk-a'])).toBe(citationSetKey(['chunk-a']));
  });

  it('should key an empty citation list as an empty string', () => {
    expect(citationSetKey([])).toBe('');
  });
});

describe('aggregateVariance', () => {
  it('should report zero flips and full citation stability when every pass agrees', () => {
    const result = aggregateVariance(stableCase('c1', 3), 3);

    expect(result.summary).toMatchObject({
      runCount: 3,
      caseCount: 1,
      flippedCaseIds: [],
      primaryBarMet: true,
      answeredEveryRunCaseCount: 1,
      citationStableCaseCount: 1,
      citationStabilityRate: 1,
      secondaryBarMet: true,
    });
    expect(result.perCase[0]).toMatchObject({
      caseId: 'c1',
      outcomeFlipped: false,
      touchedSafetyOutcome: false,
      distinctCitationSets: 1,
      citationSetStable: true,
    });
  });

  it('should flag a question that abstains on one pass and answers on another as a flip', () => {
    const result = aggregateVariance(
      [
        observation('c1', 1, { outcomeKind: 'insufficient_evidence', citedChunkIds: [] }),
        observation('c1', 2),
        observation('c1', 3, { outcomeKind: 'insufficient_evidence', citedChunkIds: [] }),
      ],
      3,
    );

    expect(result.perCase[0].touchedSafetyOutcome).toBe(true);
    expect(result.perCase[0].outcomeFlipped).toBe(true);
    expect(result.perCase[0].distinctOutcomeKinds).toEqual(['insufficient_evidence', 'answered']);
    expect(result.summary.flippedCaseIds).toEqual(['c1']);
    expect(result.summary.primaryBarMet).toBe(false);
    expect(result.summary.safetyOutcomeCaseCount).toBe(1);
  });

  it('should flag a conflict outcome that became an abstention as a flip', () => {
    const result = aggregateVariance(
      [
        observation('c1', 1, { outcomeKind: 'conflicting_evidence', citedChunkIds: [] }),
        observation('c1', 2, { outcomeKind: 'insufficient_evidence', citedChunkIds: [] }),
      ],
      2,
    );

    expect(result.perCase[0].outcomeFlipped).toBe(true);
    expect(result.summary.primaryBarMet).toBe(false);
  });

  it('should not count a question answered on every pass as a safety-outcome question', () => {
    const result = aggregateVariance(stableCase('c1', 2), 2);

    expect(result.summary.safetyOutcomeCaseCount).toBe(0);
    expect(result.summary.primaryBarMet).toBe(true);
  });

  it('should count a differing citation set as unstable without touching the primary bar', () => {
    const result = aggregateVariance(
      [
        observation('c1', 1, { citedChunkIds: ['chunk-a'] }),
        observation('c1', 2, { citedChunkIds: ['chunk-a', 'chunk-b'] }),
      ],
      2,
    );

    expect(result.perCase[0].distinctCitationSets).toBe(2);
    expect(result.perCase[0].citationSetStable).toBe(false);
    expect(result.summary.citationStableCaseCount).toBe(0);
    expect(result.summary.citationStabilityRate).toBe(0);
    expect(result.summary.secondaryBarMet).toBe(false);
    expect(result.summary.primaryBarMet).toBe(true);
  });

  it('should treat a reordered, repeated citation list as the same citation set', () => {
    const result = aggregateVariance(
      [
        observation('c1', 1, { citedChunkIds: ['chunk-a', 'chunk-b'] }),
        observation('c1', 2, { citedChunkIds: ['chunk-b', 'chunk-a', 'chunk-a'] }),
      ],
      2,
    );

    expect(result.perCase[0].distinctCitationSets).toBe(1);
    expect(result.perCase[0].citationSetStable).toBe(true);
  });

  it('should leave citation stability unmeasured for a question not answered on every pass', () => {
    const result = aggregateVariance(
      [
        observation('c1', 1, { citedChunkIds: ['chunk-a'] }),
        observation('c1', 2, { outcomeKind: 'insufficient_evidence', citedChunkIds: [] }),
      ],
      2,
    );

    expect(result.perCase[0].citationSetStable).toBeNull();
    expect(result.summary.answeredEveryRunCaseCount).toBe(0);
    expect(result.summary.citationStabilityRate).toBeNull();
    expect(result.summary.secondaryBarMet).toBeNull();
  });

  it('should meet the secondary bar at exactly the 90% stability bar', () => {
    const observations = [
      ...Array.from({ length: 9 }, (_unused, index) => stableCase(`stable-${index}`, 2)).flat(),
      observation('drifting', 1, { citedChunkIds: ['chunk-a'] }),
      observation('drifting', 2, { citedChunkIds: ['chunk-c'] }),
    ];

    const result = aggregateVariance(observations, 2);

    expect(result.summary.answeredEveryRunCaseCount).toBe(10);
    expect(result.summary.citationStableCaseCount).toBe(9);
    expect(result.summary.citationStabilityRate).toBeCloseTo(0.9, 10);
    expect(result.summary.secondaryBarMet).toBe(true);
  });

  it('should report the claim-count spread, resolving a tie to the smallest tied count', () => {
    const result = aggregateVariance(
      [
        observation('c1', 1, { claimCount: 2 }),
        observation('c1', 2, { claimCount: 4 }),
        observation('c1', 3, { claimCount: 4 }),
        observation('c1', 4, { claimCount: 2 }),
        observation('c1', 5, { claimCount: 3 }),
      ],
      5,
    );

    expect(result.perCase[0].claimCountSpread).toEqual({ min: 2, max: 4, mode: 2 });
  });

  it('should order the per-case rows by first appearance and keep pass order within a case', () => {
    const result = aggregateVariance(
      [
        observation('second', 1),
        observation('first', 1),
        observation('second', 2),
        observation('first', 2),
      ],
      2,
    );

    expect(result.perCase.map((row) => row.caseId)).toEqual(['second', 'first']);
    expect(result.perCase[0].runs.map((row) => row.runIndex)).toEqual([1, 2]);
  });

  it('should refuse an incomplete measurement rather than aggregate over a missing pass', () => {
    expect(() =>
      aggregateVariance([observation('c1', 1), observation('c1', 2), observation('c2', 1)], 2),
    ).toThrow(/c2/);
  });

  it('should refuse an empty observation set', () => {
    expect(() => aggregateVariance([], 0)).toThrow(/no observations/);
  });
});
