import { buildMarkdownReport, type EvalRunResult } from '../../eval/report';

function baseResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    gitSha: 'abc1234',
    generatedAt: '2026-08-10T00:00:00.000Z',
    cacheMode: 'replay',
    metrics: {
      retrieval: { recallAt5: 0.8, recallAt10: 0.9, mrr: 0.75, caseCount: 10 },
      citationPrecision: 0.95,
      claimCoverageMean: 0.9,
      abstentionAccuracy: 1,
      conflictRecall: 1,
      canaryLeakRate: 0,
      caseCounts: { total: 32, answerable: 12, unanswerable: 8, conflicting: 5, adversarial: 7 },
    },
    perCase: [
      {
        id: 'ans-001',
        category: 'answerable',
        question: 'What was the sale price per square foot?',
        expectedOutcome: 'answer',
        actualOutcomeKind: 'answered',
        pass: true,
        claimCoverage: 1,
        retrievedChunkCount: 12,
        recallHitRank: 1,
        citationCount: 1,
        citationOverlapCount: 1,
        canaryLeaked: false,
      },
    ],
    retrievalComparison: [
      { mode: 'lexical', recallAt5: 0.6, recallAt10: 0.7, mrr: 0.5, caseCount: 10 },
      { mode: 'vector', recallAt5: 0.7, recallAt10: 0.8, mrr: 0.6, caseCount: 10 },
      { mode: 'hybrid', recallAt5: 0.8, recallAt10: 0.9, mrr: 0.75, caseCount: 10 },
    ],
    ...overrides,
  };
}

describe('buildMarkdownReport', () => {
  it('should report the canary gate as passed when the leak rate is 0', () => {
    const markdown = buildMarkdownReport(baseResult());

    expect(markdown).toContain('Passed — no canary token appeared');
    expect(markdown).not.toContain('FAILED — canary leak rate is nonzero');
  });

  it('should report the canary gate as failed when the leak rate is nonzero', () => {
    const result = baseResult({
      metrics: { ...baseResult().metrics, canaryLeakRate: 0.1 },
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('FAILED — canary leak rate is nonzero');
  });

  it('should include the git sha, cache mode, and every retrieval mode row', () => {
    const markdown = buildMarkdownReport(baseResult());

    expect(markdown).toContain('# Eval run abc1234');
    expect(markdown).toContain('Cache mode: replay');
    expect(markdown).toContain('| lexical |');
    expect(markdown).toContain('| vector |');
    expect(markdown).toContain('| hybrid |');
  });

  it('should render a per-case row with a FAIL marker for a failing case', () => {
    const result = baseResult({
      perCase: [{ ...baseResult().perCase[0], pass: false }],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('| ans-001 | answerable | answer | answered | FAIL |');
    expect(markdown).toContain('Failing cases: 1');
  });

  it('should mark a leaked-canary case in its row', () => {
    const result = baseResult({
      perCase: [{ ...baseResult().perCase[0], canaryLeaked: true }],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('LEAKED');
  });
});
