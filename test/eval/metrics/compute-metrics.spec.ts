import { computeMetrics, type CaseResult } from '../../../eval/metrics/compute-metrics';

function makeCase(
  overrides: Partial<CaseResult> & Pick<CaseResult, 'id' | 'category'>,
): CaseResult {
  return {
    actualOutcomeKind: 'answered',
    retrievedOverlaps: [],
    citationOverlaps: [],
    canaryOwnVoiceLeaked: false,
    canaryVerifiedQuoteLeaked: false,
    answerContentCheck: null,
    conflictScopeCheck: null,
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

  it('should compute a nonzero own-voice canary leak rate across the whole dataset, not only adversarial cases', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', canaryOwnVoiceLeaked: true }),
      makeCase({ id: 'adv-001', category: 'adversarial', canaryOwnVoiceLeaked: false }),
    ];

    expect(computeMetrics(results).canaryOwnVoiceLeakRate).toBeCloseTo(0.5);
  });

  it("should report a 0 own-voice canary leak rate when nothing leaked in the model's own voice", () => {
    const results: CaseResult[] = [
      makeCase({ id: 'adv-001', category: 'adversarial', canaryOwnVoiceLeaked: false }),
    ];

    expect(computeMetrics(results).canaryOwnVoiceLeakRate).toBe(0);
  });

  it('should compute the verified-quote canary leak rate independently of the own-voice rate', () => {
    const results: CaseResult[] = [
      // Own voice only — no verified-quote leak on this case.
      makeCase({ id: 'ans-001', category: 'answerable', canaryOwnVoiceLeaked: true }),
      // Verified quote only — correctly cited hostile text, not a hard-gate failure.
      makeCase({
        id: 'adv-001',
        category: 'adversarial',
        canaryOwnVoiceLeaked: false,
        canaryVerifiedQuoteLeaked: true,
      }),
    ];

    const metrics = computeMetrics(results);
    expect(metrics.canaryOwnVoiceLeakRate).toBeCloseTo(0.5);
    expect(metrics.canaryVerifiedQuoteLeakRate).toBeCloseTo(0.5);
  });

  it('should report a 0 verified-quote canary leak rate when nothing was cited from hostile text', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'adv-001', category: 'adversarial', canaryVerifiedQuoteLeaked: false }),
    ];

    expect(computeMetrics(results).canaryVerifiedQuoteLeakRate).toBe(0);
  });

  it('should compute answer content accuracy only over cases where the check applied', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', answerContentCheck: true }),
      makeCase({ id: 'ans-002', category: 'answerable', answerContentCheck: false }),
      // Not applicable — e.g. an unanswerable case, or an answerable case that abstained instead
      // of answering — must not count as a pass or drag down the denominator.
      makeCase({ id: 'una-001', category: 'unanswerable', answerContentCheck: null }),
    ];

    expect(computeMetrics(results).answerContentAccuracy).toBeCloseTo(0.5);
  });

  it('should return 0 answer content accuracy when the check never applied', () => {
    const results: CaseResult[] = [makeCase({ id: 'una-001', category: 'unanswerable' })];

    expect(computeMetrics(results).answerContentAccuracy).toBe(0);
  });

  it('should compute conflict scope accuracy only over cases where the check applied', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'con-001', category: 'conflicting', conflictScopeCheck: true }),
      makeCase({ id: 'con-002', category: 'conflicting', conflictScopeCheck: false }),
      // Not applicable — the case did not even produce a `conflicting_evidence` outcome to score
      // the scope of — must not count as a pass or drag down the denominator.
      makeCase({ id: 'con-003', category: 'conflicting', conflictScopeCheck: null }),
    ];

    expect(computeMetrics(results).conflictScopeAccuracy).toBeCloseTo(0.5);
  });

  it('should return 0 conflict scope accuracy when the check never applied', () => {
    const results: CaseResult[] = [makeCase({ id: 'con-001', category: 'conflicting' })];

    expect(computeMetrics(results).conflictScopeAccuracy).toBe(0);
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
