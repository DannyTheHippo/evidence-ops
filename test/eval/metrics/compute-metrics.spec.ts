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
    totalClaimCount: 0,
    tabularClaimCount: 0,
    tabularGroundedCount: 0,
    atomDroppedClaimCount: 0,
    contradictionDroppedClaimCount: 0,
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

  it('should compute the tabular grounded rate as a sum of counts, not a mean of per-case rates', () => {
    const results: CaseResult[] = [
      makeCase({
        id: 'ans-001',
        category: 'answerable',
        tabularClaimCount: 4,
        tabularGroundedCount: 1,
      }),
      makeCase({
        id: 'ans-002',
        category: 'answerable',
        tabularClaimCount: 1,
        tabularGroundedCount: 1,
      }),
    ];

    // 2/5, not the mean of 1/4 and 1/1 — summed numerator and denominator across cases.
    expect(computeMetrics(results).tabularGroundedRate).toBeCloseTo(2 / 5);
    expect(computeMetrics(results).tabularClaimCount).toBe(5);
  });

  it('should return 0 tabular grounded rate when no case carried a tabular claim', () => {
    const results: CaseResult[] = [makeCase({ id: 'ans-001', category: 'answerable' })];

    const metrics = computeMetrics(results);
    expect(metrics.tabularGroundedRate).toBe(0);
    expect(metrics.tabularClaimCount).toBe(0);
  });

  it('should compute the coverage and contradiction drop rates over total claim count', () => {
    const results: CaseResult[] = [
      makeCase({
        id: 'ans-001',
        category: 'answerable',
        totalClaimCount: 4,
        atomDroppedClaimCount: 1,
        contradictionDroppedClaimCount: 2,
      }),
      makeCase({
        id: 'ans-002',
        category: 'answerable',
        totalClaimCount: 6,
        atomDroppedClaimCount: 1,
      }),
    ];

    const metrics = computeMetrics(results);
    expect(metrics.coverageDropRate).toBeCloseTo(2 / 10);
    expect(metrics.contradictionDropRate).toBeCloseTo(2 / 10);
  });

  it('should return 0 for the drop rates when no case reported any claims', () => {
    const results: CaseResult[] = [makeCase({ id: 'una-001', category: 'unanswerable' })];

    const metrics = computeMetrics(results);
    expect(metrics.coverageDropRate).toBe(0);
    expect(metrics.contradictionDropRate).toBe(0);
  });

  it('should compute the ledger resolved rate over every case, not only the resolved ones', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', ledgerResolved: true }),
      makeCase({ id: 'ans-002', category: 'answerable', ledgerResolved: false }),
      makeCase({ id: 'ans-003', category: 'answerable' }),
      makeCase({ id: 'una-001', category: 'unanswerable', ledgerResolved: true }),
    ];

    expect(computeMetrics(results).ledgerResolvedRate).toBeCloseTo(0.5);
  });

  it('should return 0 ledger resolved rate when there are no cases', () => {
    expect(computeMetrics([]).ledgerResolvedRate).toBe(0);
  });

  it('should compute the ledger gate survival rate over resolved cases only', () => {
    const results: CaseResult[] = [
      makeCase({
        id: 'ans-001',
        category: 'answerable',
        ledgerResolved: true,
        ledgerSurvived: true,
      }),
      makeCase({
        id: 'ans-002',
        category: 'answerable',
        ledgerResolved: true,
        ledgerSurvived: false,
      }),
      // Not resolved — must not count toward either the numerator or the denominator.
      makeCase({ id: 'ans-003', category: 'answerable', ledgerResolved: false }),
    ];

    expect(computeMetrics(results).ledgerGateSurvivalRate).toBeCloseTo(0.5);
  });

  it('should return 0 ledger gate survival rate when no case resolved', () => {
    const results: CaseResult[] = [makeCase({ id: 'ans-001', category: 'answerable' })];

    expect(computeMetrics(results).ledgerGateSurvivalRate).toBe(0);
  });

  it('should compute answer rate over answerable cases only', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', actualOutcomeKind: 'answered' }),
      makeCase({
        id: 'ans-002',
        category: 'answerable',
        actualOutcomeKind: 'insufficient_evidence',
      }),
      // A correct unanswerable case must not inflate the answerable-only denominator.
      makeCase({
        id: 'una-001',
        category: 'unanswerable',
        actualOutcomeKind: 'insufficient_evidence',
      }),
    ];

    expect(computeMetrics(results).answerRate).toBeCloseTo(0.5);
  });

  it('should return 0 answer rate when there are no answerable cases', () => {
    const results: CaseResult[] = [makeCase({ id: 'una-001', category: 'unanswerable' })];

    expect(computeMetrics(results).answerRate).toBe(0);
  });

  it('should leave retrieval latency undefined when no case carries retrievalMs', () => {
    const results: CaseResult[] = [makeCase({ id: 'ans-001', category: 'answerable' })];

    expect(computeMetrics(results).retrievalLatency).toBeUndefined();
  });

  it('should leave retrieval latency undefined when only some cases carry retrievalMs', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', retrievalMs: 100 }),
      makeCase({ id: 'ans-002', category: 'answerable' }),
    ];

    expect(computeMetrics(results).retrievalLatency).toBeUndefined();
  });

  it('should compute nearest-rank p50/p95 over a single sample as that sample', () => {
    const results: CaseResult[] = [
      makeCase({ id: 'ans-001', category: 'answerable', retrievalMs: 42 }),
    ];

    expect(computeMetrics(results).retrievalLatency).toEqual({ p50Ms: 42, p95Ms: 42 });
  });

  it('should compute nearest-rank p50/p95 over twenty samples', () => {
    // 1..20 ms, in reverse input order — nearest-rank sorts before ranking, so the input order
    // must not matter.
    const results: CaseResult[] = Array.from({ length: 20 }, (_, index) =>
      makeCase({
        id: `ans-${String(20 - index).padStart(3, '0')}`,
        category: 'answerable',
        retrievalMs: 20 - index,
      }),
    );

    // p50: ceil(0.50 * 20) = 10th smallest = 10. p95: ceil(0.95 * 20) = 19th smallest = 19.
    expect(computeMetrics(results).retrievalLatency).toEqual({ p50Ms: 10, p95Ms: 19 });
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
