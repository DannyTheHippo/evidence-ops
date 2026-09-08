import { aggregateVariance } from '../../../eval/variance/aggregate-variance';
import {
  buildVarianceMarkdownReport,
  type VarianceCaseRun,
  type VarianceRunResult,
} from '../../../eval/variance/variance-report';

function caseRun(overrides: Partial<VarianceCaseRun> & Pick<VarianceCaseRun, 'caseId'>) {
  const citedChunkIds = overrides.citedChunkIds ?? ['aaaaaaaa1111', 'bbbbbbbb2222'];
  return {
    runIndex: 1,
    question: 'What is the ARR?',
    outcomeKind: 'answered',
    claimCount: 2,
    retrievedChunkIds: citedChunkIds,
    citations: citedChunkIds.map((chunkId) => ({ chunkId, quote: 'quoted' })),
    ...overrides,
    citedChunkIds,
  } satisfies VarianceCaseRun;
}

function report(observations: readonly VarianceCaseRun[], runCount: number): VarianceRunResult {
  return {
    baseGitSha: 'abc123',
    datasetFingerprint: 'dataset-fingerprint',
    generatedAt: '2026-08-27T12:00:00.000Z',
    runCount,
    requestedRunCount: runCount,
    corpusFingerprint: 'fingerprint',
    modelCacheMode: 'off',
    embeddingCacheMode: 'replay',
    passLabels: Array.from({ length: runCount }, (_unused, index) => ({
      runIndex: index + 1,
      gitSha: 'abc123-dirty',
      startedAt: `2026-08-27T12:0${index}:00.000Z`,
    })),
    observations,
    aggregate: aggregateVariance(observations, runCount),
  };
}

describe('buildVarianceMarkdownReport', () => {
  it('should report both bars as met when every pass agrees', () => {
    const markdown = buildVarianceMarkdownReport(
      report([caseRun({ caseId: 'c1', runIndex: 1 }), caseRun({ caseId: 'c1', runIndex: 2 })], 2),
    );

    expect(markdown).toContain('**Primary — abstention stability (zero flips).** Met');
    expect(markdown).toContain('Met — 1 of 1 questions answered in every pass cited an identical');
    expect(markdown).not.toContain('MISSED');
  });

  it('should name the flipped question when the primary bar is missed', () => {
    const markdown = buildVarianceMarkdownReport(
      report(
        [
          caseRun({ caseId: 'flipper', runIndex: 1 }),
          caseRun({
            caseId: 'flipper',
            runIndex: 2,
            outcomeKind: 'insufficient_evidence',
            claimCount: 0,
            citedChunkIds: [],
          }),
        ],
        2,
      ),
    );

    expect(markdown).toContain('**MISSED — 1 question(s) changed outcome kind: flipper.');
  });

  it('should report the secondary bar as missed with its rate when citation sets differ', () => {
    const markdown = buildVarianceMarkdownReport(
      report(
        [
          caseRun({ caseId: 'c1', runIndex: 1, citedChunkIds: ['aaaaaaaa1111'] }),
          caseRun({ caseId: 'c1', runIndex: 2, citedChunkIds: ['bbbbbbbb2222'] }),
        ],
        2,
      ),
    );

    expect(markdown).toContain(
      '**MISSED — 0 of 1 questions answered in every pass cited an identical set (0.0%), below ' +
        'the 90.0% bar.**',
    );
  });

  it('should say the secondary bar is not evaluable when nothing was answered in every pass', () => {
    const markdown = buildVarianceMarkdownReport(
      report(
        [
          caseRun({
            caseId: 'c1',
            runIndex: 1,
            outcomeKind: 'insufficient_evidence',
            claimCount: 0,
            citedChunkIds: [],
          }),
        ],
        1,
      ),
    );

    expect(markdown).toContain('**Not evaluable — no question was answered in every pass');
  });

  it('should render one raw row per question per pass, with abbreviated chunk ids', () => {
    const markdown = buildVarianceMarkdownReport(
      report(
        [
          caseRun({ caseId: 'c1', runIndex: 1 }),
          caseRun({ caseId: 'c1', runIndex: 2 }),
          caseRun({ caseId: 'c2', runIndex: 1, claimCount: 3 }),
          caseRun({ caseId: 'c2', runIndex: 2, claimCount: 3 }),
        ],
        2,
      ),
    );

    expect(markdown).toContain('| c1 | 1 | answered | 2 | aaaaaaaa bbbbbbbb |');
    expect(markdown).toContain('| c1 | 2 | answered | 2 | aaaaaaaa bbbbbbbb |');
    expect(markdown).toContain('| c2 | 1 | answered | 3 | aaaaaaaa bbbbbbbb |');
    expect(markdown).toContain('| c2 | 2 | answered | 3 | aaaaaaaa bbbbbbbb |');
  });

  it('should render a citation-free pass with a placeholder rather than an empty cell', () => {
    const markdown = buildVarianceMarkdownReport(
      report(
        [
          caseRun({
            caseId: 'c1',
            runIndex: 1,
            outcomeKind: 'conflicting_evidence',
            claimCount: 0,
            citedChunkIds: [],
          }),
        ],
        1,
      ),
    );

    expect(markdown).toContain('| c1 | 1 | conflicting_evidence | 0 | - |');
  });

  it('should render the dataset fingerprint and one pass line per completed pass', () => {
    const markdown = buildVarianceMarkdownReport(
      report([caseRun({ caseId: 'c1', runIndex: 1 }), caseRun({ caseId: 'c1', runIndex: 2 })], 2),
    );

    expect(markdown).toContain('Dataset fingerprint: dataset-fingerprint');
    expect(markdown).toContain('Pass 1: abc123-dirty (2026-08-27T12:00:00.000Z)');
    expect(markdown).toContain('Pass 2: abc123-dirty (2026-08-27T12:01:00.000Z)');
  });

  it('should render the header without bars, summary or per-question tables when no pass has completed', () => {
    const incomplete = report([caseRun({ caseId: 'c1', runIndex: 1 })], 1);
    const markdown = buildVarianceMarkdownReport({
      ...incomplete,
      runCount: 0,
      aggregate: undefined,
    });

    expect(markdown).toContain('No pass has completed yet');
    expect(markdown).not.toContain('## Bars');
    expect(markdown).not.toContain('## Summary');
    expect(markdown).not.toContain('## Per-question spread');
  });
});
