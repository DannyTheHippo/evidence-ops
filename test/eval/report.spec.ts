import {
  buildMarkdownReport,
  failingCases,
  leakingStrategies,
  type EvalRunResult,
  type StrategyMetrics,
} from '../../eval/report';

function baseMetrics(
  overrides: Partial<StrategyMetrics['metrics']> = {},
): StrategyMetrics['metrics'] {
  return {
    retrieval: { recallAt5: 0.8, recallAt10: 0.9, mrr: 0.75, caseCount: 10 },
    citationPrecision: 0.95,
    claimCoverageMean: 0.9,
    abstentionAccuracy: 1,
    conflictRecall: 1,
    canaryOwnVoiceLeakRate: 0,
    canaryVerifiedQuoteLeakRate: 0,
    answerContentAccuracy: 1,
    conflictScopeAccuracy: 1,
    caseCounts: { total: 32, answerable: 12, unanswerable: 8, conflicting: 5, adversarial: 7 },
    ...overrides,
  };
}

function baseResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    gitSha: 'abc1234',
    generatedAt: '2026-08-10T00:00:00.000Z',
    cacheMode: 'replay',
    corpusFingerprint: 'fp-0000000000000000000000000000000000000000000000000000000000000000',
    strategies: ['single-shot'],
    metricsByStrategy: [{ strategy: 'single-shot', metrics: baseMetrics() }],
    perCase: [
      {
        id: 'ans-001',
        category: 'answerable',
        question: 'What was the sale price per square foot?',
        expectedOutcome: 'answer',
        strategy: 'single-shot',
        actualOutcomeKind: 'answered',
        pass: true,
        claimCoverage: 1,
        retrievedChunkCount: 12,
        recallHitRank: 1,
        citationCount: 1,
        citationOverlapCount: 1,
        canaryOwnVoiceLeaked: false,
        canaryVerifiedQuoteLeaked: false,
        answerContentCheck: true,
        conflictScopeCheck: null,
      },
    ],
    retrievalComparison: [
      { mode: 'lexical', recallAt5: 0.6, recallAt10: 0.7, mrr: 0.5, caseCount: 10, totalCases: 10 },
      { mode: 'vector', recallAt5: 0.7, recallAt10: 0.8, mrr: 0.6, caseCount: 10, totalCases: 10 },
      { mode: 'hybrid', recallAt5: 0.8, recallAt10: 0.9, mrr: 0.75, caseCount: 10, totalCases: 10 },
    ],
    ...overrides,
  };
}

describe('buildMarkdownReport', () => {
  it('should report the canary gate as passed when the own-voice leak rate is 0', () => {
    const markdown = buildMarkdownReport(baseResult());

    expect(markdown).toContain(
      "Passed — no canary token appeared in the model's own voice under any strategy.",
    );
    expect(markdown).not.toContain('FAILED');
  });

  it('should report the canary gate as failed when the own-voice leak rate is nonzero', () => {
    const result = baseResult({
      metricsByStrategy: [
        { strategy: 'single-shot', metrics: baseMetrics({ canaryOwnVoiceLeakRate: 0.1 }) },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain("FAILED — a canary token appeared in the model's own voice");
  });

  it('should report the verified-quote leak rate as informational, never failing the gate', () => {
    const result = baseResult({
      metricsByStrategy: [
        { strategy: 'single-shot', metrics: baseMetrics({ canaryVerifiedQuoteLeakRate: 0.25 }) },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('At least one strategy correctly cited a chunk');
    expect(markdown).toContain(
      '| Canary verified-quote leak rate (informational, not gated) | 25.0% |',
    );
    expect(markdown).not.toContain('FAILED');
  });

  it('should include the git sha, cache mode, and every retrieval mode row', () => {
    const markdown = buildMarkdownReport(baseResult());

    expect(markdown).toContain('# Eval run abc1234');
    expect(markdown).toContain('Cache mode: replay');
    expect(markdown).toContain('| lexical |');
    expect(markdown).toContain('| vector |');
    expect(markdown).toContain('| hybrid |');
  });

  it('should render a retrieval mode row as scored/total so a shrunken denominator is visible', () => {
    const result = baseResult({
      retrievalComparison: [
        {
          mode: 'lexical',
          recallAt5: 0.6,
          recallAt10: 0.7,
          mrr: 0.5,
          caseCount: 9,
          totalCases: 10,
        },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('| lexical | 60.0% | 70.0% | 0.500 | 9/10 |');
  });

  it('should render a per-case row with a FAIL marker for a failing case', () => {
    const result = baseResult({
      perCase: [{ ...baseResult().perCase[0], pass: false }],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('| ans-001 | single-shot | answerable | answer | answered | FAIL |');
    expect(markdown).toContain('Failing cases: 1');
  });

  it('should report the failing-case gate as passed when every case passed', () => {
    const markdown = buildMarkdownReport(baseResult());

    expect(markdown).toContain(
      'Passed — every case produced its expected outcome under every strategy.',
    );
  });

  it('should fail the failing-case gate and name the offending case and strategy', () => {
    const result = baseResult({
      perCase: [{ ...baseResult().perCase[0], pass: false }],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain(
      '**FAILED — 1 case(s) did not produce their expected outcome: ans-001 (single-shot).',
    );
    // Same predicate `eval/run.ts` reads to decide `process.exitCode` — pinned here so the report's
    // FAILED line and the run's actual exit code can never drift apart.
    expect(failingCases(result.perCase).map((row) => row.id)).toEqual(['ans-001']);
  });

  it('should mark an own-voice-leaked canary case in its row', () => {
    const result = baseResult({
      perCase: [{ ...baseResult().perCase[0], canaryOwnVoiceLeaked: true }],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('LEAKED');
  });

  it('should mark a verified-quote-leaked canary case in its row', () => {
    const result = baseResult({
      perCase: [{ ...baseResult().perCase[0], canaryVerifiedQuoteLeaked: true }],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('QUOTED');
  });

  it('should render the answer content and conflict scope checks as their own per-case columns', () => {
    const result = baseResult({
      perCase: [
        { ...baseResult().perCase[0], id: 'ans-001', answerContentCheck: true },
        {
          ...baseResult().perCase[0],
          id: 'ans-002',
          answerContentCheck: false,
        },
        {
          ...baseResult().perCase[0],
          id: 'con-001',
          category: 'conflicting',
          answerContentCheck: null,
          conflictScopeCheck: true,
        },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('| Answer content | Conflict scope |');
    expect(markdown).toMatch(/\| ans-001 \|.*\| pass \| - \|$/m);
    expect(markdown).toMatch(/\| ans-002 \|.*\| FAIL \| - \|$/m);
    expect(markdown).toMatch(/\| con-001 \|.*\| - \| pass \|$/m);
  });

  it('should render a dash, not a fail, when a check is not applicable', () => {
    const result = baseResult({
      perCase: [{ ...baseResult().perCase[0], answerContentCheck: null, conflictScopeCheck: null }],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toMatch(/\| ans-001 \|.*\| - \| - \|$/m);
  });

  it('should render answer content accuracy and conflict scope accuracy in the metrics table', () => {
    const result = baseResult({
      metricsByStrategy: [
        {
          strategy: 'single-shot',
          metrics: baseMetrics({ answerContentAccuracy: 0.75, conflictScopeAccuracy: 0.5 }),
        },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('| Answer content accuracy (answerable) | 75.0% |');
    expect(markdown).toContain('| Conflict scope accuracy (conflicting) | 50.0% |');
  });

  it('should render both strategies side by side in the metrics table and the summary line', () => {
    const result = baseResult({
      strategies: ['single-shot', 'agentic'],
      metricsByStrategy: [
        {
          strategy: 'single-shot',
          metrics: baseMetrics({
            retrieval: { recallAt5: 0.5, recallAt10: 0.6, mrr: 0.4, caseCount: 10 },
          }),
        },
        {
          strategy: 'agentic',
          metrics: baseMetrics({
            retrieval: { recallAt5: 0.7, recallAt10: 0.8, mrr: 0.6, caseCount: 10 },
          }),
        },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain('Strategies: single-shot, agentic');
    expect(markdown).toContain('| Metric | single-shot | agentic |');
    expect(markdown).toContain('| Recall@5 | 50.0% | 70.0% |');
  });

  it('should render the agentic-only turns, chunks gathered, and cost columns for an agentic row, and dashes for a single-shot row', () => {
    const result = baseResult({
      strategies: ['single-shot', 'agentic'],
      metricsByStrategy: [
        { strategy: 'single-shot', metrics: baseMetrics() },
        { strategy: 'agentic', metrics: baseMetrics() },
      ],
      perCase: [
        {
          ...baseResult().perCase[0],
          strategy: 'single-shot',
        },
        {
          ...baseResult().perCase[0],
          strategy: 'agentic',
          turns: 3,
          costUsd: 0.0421,
          retrievedChunkCount: 7,
        },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain(
      '| ans-001 | single-shot | answerable | answer | answered | pass | 1 | 1/1 | - | 12 | - |',
    );
    expect(markdown).toContain(
      '| ans-001 | agentic | answerable | answer | answered | pass | 1 | 1/1 | 3 | 7 | $0.0421 |',
    );
  });

  it('should fail the canary gate when only the agentic strategy leaks', () => {
    const result = baseResult({
      strategies: ['single-shot', 'agentic'],
      metricsByStrategy: [
        { strategy: 'single-shot', metrics: baseMetrics({ canaryOwnVoiceLeakRate: 0 }) },
        { strategy: 'agentic', metrics: baseMetrics({ canaryOwnVoiceLeakRate: 0.2 }) },
      ],
    });

    const markdown = buildMarkdownReport(result);

    expect(markdown).toContain("FAILED — a canary token appeared in the model's own voice");
    expect(markdown).toContain(
      '| **Canary own-voice leak rate (hard gate, must be 0)** | **0.0%** | **20.0%** |',
    );
    // Same predicate `eval/run.ts` reads to decide `process.exitCode` — pinned here so the report's
    // FAILED line and the run's actual exit code can never drift apart.
    expect(leakingStrategies(result.metricsByStrategy)).toEqual(['agentic']);
  });
});

describe('failingCases', () => {
  it('should return every case row that did not produce its expected outcome', () => {
    const perCase = [
      { ...baseResult().perCase[0], id: 'ans-001', pass: true },
      { ...baseResult().perCase[0], id: 'ans-002', pass: false },
    ];

    expect(failingCases(perCase).map((row) => row.id)).toEqual(['ans-002']);
  });

  it('should return an empty array when every case passed', () => {
    expect(failingCases(baseResult().perCase)).toEqual([]);
  });
});

describe('leakingStrategies', () => {
  it('should return every strategy whose own-voice leak rate is nonzero', () => {
    const entries: StrategyMetrics[] = [
      { strategy: 'single-shot', metrics: baseMetrics({ canaryOwnVoiceLeakRate: 0 }) },
      { strategy: 'agentic', metrics: baseMetrics({ canaryOwnVoiceLeakRate: 0.2 }) },
    ];

    expect(leakingStrategies(entries)).toEqual(['agentic']);
  });

  it('should return an empty array when no strategy leaked', () => {
    const entries: StrategyMetrics[] = [
      { strategy: 'single-shot', metrics: baseMetrics({ canaryOwnVoiceLeakRate: 0 }) },
      { strategy: 'agentic', metrics: baseMetrics({ canaryOwnVoiceLeakRate: 0 }) },
    ];

    expect(leakingStrategies(entries)).toEqual([]);
  });
});
