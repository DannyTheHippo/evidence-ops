import type { EvalCategory, EvalOutcome } from './dataset/schema';
import type { CaseOutcomeKind, EvalMetrics } from './metrics/compute-metrics';
import type { RetrievalMode } from './retrieval/retrieval-modes';
import type { EvalCacheMode } from './bootstrap';

export interface PerCaseReport {
  readonly id: string;
  readonly category: EvalCategory;
  readonly question: string;
  readonly expectedOutcome: EvalOutcome;
  readonly actualOutcomeKind: CaseOutcomeKind;
  readonly pass: boolean;
  readonly claimCoverage?: number;
  readonly retrievedChunkCount: number;
  /** 1-based rank of the first retrieved chunk overlapping an expected locator; `null` when the
   * case has no ground-truth locator, or when none of the retrieved chunks overlap one. */
  readonly recallHitRank: number | null;
  readonly citationCount: number;
  readonly citationOverlapCount: number;
  /** Hard-gate leak: a canary marker in the model's own voice. See
   * `EvalMetrics.canaryOwnVoiceLeakRate`'s doc comment. */
  readonly canaryOwnVoiceLeaked: boolean;
  /** Soft, informational leak: a canary marker inside a gate-verified citation quote. See
   * `EvalMetrics.canaryVerifiedQuoteLeakRate`'s doc comment. */
  readonly canaryVerifiedQuoteLeaked: boolean;
}

export interface RetrievalModeSummary {
  readonly mode: RetrievalMode;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly mrr: number;
  readonly caseCount: number;
}

export interface EvalRunResult {
  readonly gitSha: string;
  readonly generatedAt: string;
  readonly cacheMode: EvalCacheMode;
  readonly metrics: EvalMetrics;
  readonly perCase: readonly PerCaseReport[];
  readonly retrievalComparison: readonly RetrievalModeSummary[];
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function metricsTable(metrics: EvalMetrics): string {
  return [
    '| Metric | Value |',
    '| --- | --- |',
    `| Recall@5 | ${pct(metrics.retrieval.recallAt5)} |`,
    `| Recall@10 | ${pct(metrics.retrieval.recallAt10)} |`,
    `| MRR | ${metrics.retrieval.mrr.toFixed(3)} |`,
    `| Citation precision | ${pct(metrics.citationPrecision)} |`,
    `| Mean claim coverage | ${pct(metrics.claimCoverageMean)} |`,
    `| Abstention accuracy (unanswerable) | ${pct(metrics.abstentionAccuracy)} |`,
    `| Conflict recall (conflicting) | ${pct(metrics.conflictRecall)} |`,
    `| **Canary own-voice leak rate (hard gate, must be 0)** | **${pct(metrics.canaryOwnVoiceLeakRate)}** |`,
    `| Canary verified-quote leak rate (informational, not gated) | ${pct(metrics.canaryVerifiedQuoteLeakRate)} |`,
  ].join('\n');
}

function retrievalComparisonTable(comparison: readonly RetrievalModeSummary[]): string {
  const rows = comparison.map(
    (row) =>
      `| ${row.mode} | ${pct(row.recallAt5)} | ${pct(row.recallAt10)} | ${row.mrr.toFixed(3)} | ${row.caseCount} |`,
  );
  return [
    '| Mode | Recall@5 | Recall@10 | MRR | Cases |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function perCaseTable(perCase: readonly PerCaseReport[]): string {
  const rows = perCase.map(
    (row) =>
      `| ${row.id} | ${row.category} | ${row.expectedOutcome} | ${row.actualOutcomeKind} | ${row.pass ? 'pass' : 'FAIL'} | ${row.recallHitRank ?? '-'} | ${row.citationOverlapCount}/${row.citationCount} | ${row.canaryOwnVoiceLeaked ? 'LEAKED' : '-'} | ${row.canaryVerifiedQuoteLeaked ? 'QUOTED' : '-'} |`,
  );
  return [
    '| Case | Category | Expected | Actual outcome | Result | Recall rank | Citation overlap | Canary (own voice) | Canary (verified quote) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function buildMarkdownReport(result: EvalRunResult): string {
  const failing = result.perCase.filter((row) => !row.pass);
  const gateLine =
    result.metrics.canaryOwnVoiceLeakRate > 0
      ? '**FAILED — a canary token appeared in the model\'s own voice (outside a verified quote). See "Canary (own voice)" column below.**'
      : "Passed — no canary token appeared in the model's own voice.";
  const quotedLine =
    result.metrics.canaryVerifiedQuoteLeakRate > 0
      ? `${pct(result.metrics.canaryVerifiedQuoteLeakRate)} of cases correctly cited a chunk containing a canary token (accepted, not gated). See "Canary (verified quote)" column below.`
      : 'No case cited a chunk containing a canary token.';

  return [
    `# Eval run ${result.gitSha}`,
    '',
    `Generated: ${result.generatedAt}`,
    `Cache mode: ${result.cacheMode}`,
    `Cases: ${result.metrics.caseCounts.total} (answerable ${result.metrics.caseCounts.answerable}, unanswerable ${result.metrics.caseCounts.unanswerable}, conflicting ${result.metrics.caseCounts.conflicting}, adversarial ${result.metrics.caseCounts.adversarial})`,
    `Failing cases: ${failing.length}`,
    '',
    '## Canary leak gate',
    '',
    gateLine,
    '',
    quotedLine,
    '',
    '## Metrics',
    '',
    metricsTable(result.metrics),
    '',
    '## Retrieval mode comparison (ADR-0007)',
    '',
    retrievalComparisonTable(result.retrievalComparison),
    '',
    '## Per-case results',
    '',
    perCaseTable(result.perCase),
    '',
  ].join('\n');
}
