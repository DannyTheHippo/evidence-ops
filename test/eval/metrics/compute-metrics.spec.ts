import { computeMetrics, type CaseResult } from '../../../eval/metrics/compute-metrics';

function makeCase(
  overrides: Partial<CaseResult> & Pick<CaseResult, 'id' | 'category'>,
): CaseResult {
  return {
    actualOutcomeKind: 'answered',
    retrievedOverlaps: [],
    citationOverlaps: [],
    canaryLeaked: false,
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('should compute recall@5, recall@10 and MRR only over locator-bearing cases', () => {
    const results: CaseResult[] = [
      // hit at rank 1
      makeCase({ id: 'ans-001', category: 'answerable', retrievedOverlaps: [true, false] }),
      // hit at rank 3 — inside @5/@10 but not @1
      makeCase({
        id: 'ans-002',
        category: 'answerable',
        retrievedOverlaps: [false, false, true, false, false, false],
      }),
      // miss entirely
      makeCase({
        id: 'ans-003',
        category: 'answerable',
        retrievedOverlaps: [false, false, false, false, false, false, false, false, false, false],
      }),
      // no ground truth locator at all — must not count toward recall/MRR
      makeCase({ id: 'una-001', category: 'unanswerable', retrievedOverlaps: [] }),
    ];

    const metrics = computeMetrics(results);

    expect(metrics.retrieval.caseCount).toBe(3);
    expect(metrics.retrieval.recallAt5).toBeCloseTo(2 / 3);
    expect(metrics.retrieval.recallAt10).toBeCloseTo(2 / 3);
    expect(metrics.retrieval.mrr).toBeCloseTo((1 + 1 / 3 + 0) / 3);
  });

  it('should treat a hit beyond @5 as absent from recall@5 but present in recall@10', () => {
    const results: CaseResult[] = [
      makeCase({
        id: 'ans-001',
        category: 'answerable',
        retrievedOverlaps: [false, false, false, false, false, false, true],
      }),
    ];

    const metrics = computeMetrics(results);

    expect(metrics.retrieval.recallAt5).toBe(0);
    expect(metrics.retrieval.recallAt10).toBe(1);
  });

  it('should compute citation precision across every citation on every case', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', citationOverlaps: [true, true, false] }),
      makeCase({ id: 'ans-002', category: 'answerable', citationOverlaps: [false] }),
    ];

    expect(computeMetrics(results).citationPrecision).toBeCloseTo(2 / 4);
  });

  it('should return 0 citation precision when no case produced any citation', () => {
    const results: CaseResult[] = [makeCase({ id: 'una-001', category: 'unanswerable' })];

    expect(computeMetrics(results).citationPrecision).toBe(0);
  });

  it('should average claim coverage only over cases where it was defined', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', claimCoverage: 1 }),
      makeCase({ id: 'ans-002', category: 'answerable', claimCoverage: 0.5 }),
      makeCase({ id: 'una-001', category: 'unanswerable', claimCoverage: undefined }),
    ];

    expect(computeMetrics(results).claimCoverageMean).toBeCloseTo(0.75);
  });

  it('should compute abstention accuracy over unanswerable cases only', () => {
    const results: CaseResult[] = [
      makeCase({
        id: 'una-001',
        category: 'unanswerable',
        actualOutcomeKind: 'insufficient_evidence',
      }),
      makeCase({ id: 'una-002', category: 'unanswerable', actualOutcomeKind: 'answered' }),
      // A correct answerable case must not inflate the unanswerable-only denominator.
      makeCase({ id: 'ans-001', category: 'answerable', actualOutcomeKind: 'answered' }),
    ];

    expect(computeMetrics(results).abstentionAccuracy).toBeCloseTo(0.5);
  });

  it('should return 0 abstention accuracy when there are no unanswerable cases', () => {
    const results: CaseResult[] = [makeCase({ id: 'ans-001', category: 'answerable' })];

    expect(computeMetrics(results).abstentionAccuracy).toBe(0);
  });

  it('should compute conflict recall over conflicting cases only', () => {
    const results: CaseResult[] = [
      makeCase({
        id: 'con-001',
        category: 'conflicting',
        actualOutcomeKind: 'conflicting_evidence',
      }),
      makeCase({ id: 'con-002', category: 'conflicting', actualOutcomeKind: 'answered' }),
    ];

    expect(computeMetrics(results).conflictRecall).toBeCloseTo(0.5);
  });

  it('should compute a nonzero canary leak rate across the whole dataset, not only adversarial cases', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', canaryLeaked: true }),
      makeCase({ id: 'adv-001', category: 'adversarial', canaryLeaked: false }),
    ];

    expect(computeMetrics(results).canaryLeakRate).toBeCloseTo(0.5);
  });

  it('should report a 0 canary leak rate when nothing leaked', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'adv-001', category: 'adversarial', canaryLeaked: false }),
    ];

    expect(computeMetrics(results).canaryLeakRate).toBe(0);
  });

  it('should count every category, including zero-count ones', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable' }),
      makeCase({ id: 'ans-002', category: 'answerable' }),
    ];

    expect(computeMetrics(results).caseCounts).toEqual({
      total: 2,
      answerable: 2,
      unanswerable: 0,
      conflicting: 0,
      adversarial: 0,
    });
  });
});
