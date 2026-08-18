import type { EvalCategory, EvalOutcome } from './dataset/schema';
import type { CaseOutcomeKind, EvalMetrics } from './metrics/compute-metrics';
import type { EvalRetrievalStrategy } from './retrieval/gather-evidence-for-strategy';
import type { RetrievalMode } from './retrieval/retrieval-modes';
import type { EvalCacheMode } from './bootstrap';

export interface PerCaseReport {
  readonly id: string;
  readonly category: EvalCategory;
  readonly question: string;
  readonly expectedOutcome: EvalOutcome;
  /** Which retrieval path produced this row — `eval/run.ts` scores every case once per requested
   * strategy, so a single case id can appear more than once in `EvalRunResult.perCase`. */
  readonly strategy: EvalRetrievalStrategy;
  readonly actualOutcomeKind: CaseOutcomeKind;
  readonly pass: boolean;
  readonly claimCoverage?: number;
  readonly retrievedChunkCount: number;
  /** 1-based rank of the first retrieved chunk overlapping an expected locator; `null` when the
   * case has no ground-truth locator, or when none of the retrieved chunks overlap one. */
  readonly recallHitRank: number | null;
  readonly citationCount: number;
  readonly citationOverlapCount: number;
  /** Agentic-only: model turns spent gathering this case's evidence
   * (`GatherEvidenceResult.iterations`). `undefined` for a `'single-shot'` row, which makes exactly
   * one retrieval call. */
  readonly turns?: number;
  /** Agentic-only: USD spent gathering this case's evidence (`GatherEvidenceResult.costUsd`).
   * `undefined` for a `'single-shot'` row, which spends nothing beyond the synthesis/grounding cost
   * every strategy pays identically. */
  readonly costUsd?: number;
  /** Hard-gate leak: a canary marker in the model's own voice. See
   * `EvalMetrics.canaryOwnVoiceLeakRate`'s doc comment. */
  readonly canaryOwnVoiceLeaked: boolean;
  /** Soft, informational leak: a canary marker inside a gate-verified citation quote. See
   * `EvalMetrics.canaryVerifiedQuoteLeakRate`'s doc comment. */
  readonly canaryVerifiedQuoteLeaked: boolean;
  /** Measured and reported only — never folded into `pass`. See `CaseResult.answerContentCheck`'s
   * doc comment for the applicable/not-applicable rule. */
  readonly answerContentCheck: boolean | null;
  /** Measured and reported only — never folded into `pass`. See `CaseResult.conflictScopeCheck`'s
   * doc comment for the applicable/not-applicable rule. */
  readonly conflictScopeCheck: boolean | null;
}

/** One strategy's aggregate metrics — `EvalRunResult.metricsByStrategy` carries one entry per
 * strategy `eval/run.ts` was asked to run, so the report can render them side by side. */
export interface StrategyMetrics {
  readonly strategy: EvalRetrievalStrategy;
  readonly metrics: EvalMetrics;
}

export interface RetrievalModeSummary {
  readonly mode: RetrievalMode;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly mrr: number;
  /** How many locator-bearing cases actually contributed to the metrics above — a case this mode
   * returned zero hits for has an empty overlap array and is excluded here (see
   * `computeRecallMetrics`'s doc comment), so this can be less than `totalCases`. */
  readonly caseCount: number;
  /** Every locator-bearing case the comparison attempted to score in this mode, regardless of
   * whether it ended up counted in `caseCount`. Rendered as `caseCount/totalCases` so a reader can
   * tell a shrunken denominator from a genuinely small dataset. */
  readonly totalCases: number;
}

export interface EvalRunResult {
  readonly gitSha: string;
  readonly generatedAt: string;
  readonly cacheMode: EvalCacheMode;
  /** sha256 over the tenant's sorted `evidence_chunks._id` values at run time — what a replay
   * asserts against the value recorded in `eval/cache/manifest.json` (see `run.ts`). Carried in
   * the JSON report as run provenance; not rendered into the markdown table, which is about case
   * outcomes, not cache bookkeeping. */
  readonly corpusFingerprint: string;
  /** Every strategy this run scored, in report order — the same cases run once per entry here
   * (see `PerCaseReport.strategy`). */
  readonly strategies: readonly EvalRetrievalStrategy[];
  readonly metricsByStrategy: readonly StrategyMetrics[];
  readonly perCase: readonly PerCaseReport[];
  readonly retrievalComparison: readonly RetrievalModeSummary[];
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/**
 * One column per strategy, side by side, rather than one table per strategy — the point of running
 * both is to compare them at a glance, including the two canary leak-rate rows, which is what makes
 * the hard gate's "either strategy leaks fails the run" rule (`buildMarkdownReport`'s `gateLine`)
 * visible per strategy rather than only as a combined pass/fail.
 */
function metricsComparisonTable(entries: readonly StrategyMetrics[]): string {
  const header = `| Metric | ${entries.map((entry) => entry.strategy).join(' | ')} |`;
  const divider = `| --- | ${entries.map(() => '---').join(' | ')} |`;
  const row = (label: string, format: (metrics: EvalMetrics) => string): string =>
    `| ${label} | ${entries.map((entry) => format(entry.metrics)).join(' | ')} |`;

  return [
    header,
    divider,
    row('Recall@5', (metrics) => pct(metrics.retrieval.recallAt5)),
    row('Recall@10', (metrics) => pct(metrics.retrieval.recallAt10)),
    row('MRR', (metrics) => metrics.retrieval.mrr.toFixed(3)),
    row('Citation precision', (metrics) => pct(metrics.citationPrecision)),
    row('Mean claim coverage', (metrics) => pct(metrics.claimCoverageMean)),
    row('Abstention accuracy (unanswerable)', (metrics) => pct(metrics.abstentionAccuracy)),
    row('Conflict recall (conflicting)', (metrics) => pct(metrics.conflictRecall)),
    row('Answer content accuracy (answerable)', (metrics) => pct(metrics.answerContentAccuracy)),
    row('Conflict scope accuracy (conflicting)', (metrics) => pct(metrics.conflictScopeAccuracy)),
    row(
      '**Canary own-voice leak rate (hard gate, must be 0)**',
      (metrics) => `**${pct(metrics.canaryOwnVoiceLeakRate)}**`,
    ),
    row('Canary verified-quote leak rate (informational, not gated)', (metrics) =>
      pct(metrics.canaryVerifiedQuoteLeakRate),
    ),
  ].join('\n');
}

function retrievalComparisonTable(comparison: readonly RetrievalModeSummary[]): string {
  const rows = comparison.map(
    (row) =>
      `| ${row.mode} | ${pct(row.recallAt5)} | ${pct(row.recallAt10)} | ${row.mrr.toFixed(3)} | ${row.caseCount}/${row.totalCases} |`,
  );
  return [
    '| Mode | Recall@5 | Recall@10 | MRR | Cases |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Cost is rendered to the same 4 decimal places `PER_TURN_MAX_COST_USD`-scale spend needs to stay
 * distinguishable from `$0.0000` — coarser rounding would make two agentic runs that differ by
 * fractions of a cent look identical in the report that exists specifically to catch a cost
 * difference. */
function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}

/** Renders the tri-state `boolean | null` the two measured-only checks carry: `-` for `null`
 * (not applicable to this case), never conflated with a `FAIL`. */
function formatCheck(value: boolean | null): string {
  return value === null ? '-' : value ? 'pass' : 'FAIL';
}

function perCaseTable(perCase: readonly PerCaseReport[]): string {
  const rows = perCase.map(
    (row) =>
      `| ${row.id} | ${row.strategy} | ${row.category} | ${row.expectedOutcome} | ${row.actualOutcomeKind} | ${row.pass ? 'pass' : 'FAIL'} | ${row.recallHitRank ?? '-'} | ${row.citationOverlapCount}/${row.citationCount} | ${row.turns ?? '-'} | ${row.retrievedChunkCount} | ${row.costUsd !== undefined ? formatCostUsd(row.costUsd) : '-'} | ${row.canaryOwnVoiceLeaked ? 'LEAKED' : '-'} | ${row.canaryVerifiedQuoteLeaked ? 'QUOTED' : '-'} | ${formatCheck(row.answerContentCheck)} | ${formatCheck(row.conflictScopeCheck)} |`,
  );
  return [
    '| Case | Strategy | Category | Expected | Actual outcome | Result | Recall rank | Citation overlap | Turns | Chunks gathered | Cost | Canary (own voice) | Canary (verified quote) | Answer content | Conflict scope |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

const EMPTY_CASE_COUNTS: EvalMetrics['caseCounts'] = {
  total: 0,
  answerable: 0,
  unanswerable: 0,
  conflicting: 0,
  adversarial: 0,
};

/**
 * Strategies whose own-voice canary leak rate is nonzero — the hard gate (work item 2). The single
 * predicate both `buildMarkdownReport`'s gate line and `eval/run.ts`'s process exit code read, so
 * "the report says FAILED" and "the run actually exits nonzero" can never drift apart into two
 * separately-maintained copies of the same check.
 */
export function leakingStrategies(
  entries: readonly StrategyMetrics[],
): readonly EvalRetrievalStrategy[] {
  return entries
    .filter((entry) => entry.metrics.canaryOwnVoiceLeakRate > 0)
    .map((entry) => entry.strategy);
}

/**
 * Every case row whose expected outcome did not happen — the second hard gate, alongside
 * `leakingStrategies`. Replay serves every model and embedding response from a committed fixture,
 * so a failing case is a deterministic regression in the dataset, the prompts, or retrieval rather
 * than sampling noise, and fails the run closed. Shared by `buildMarkdownReport`'s gate line and
 * `eval/run.ts`'s process exit code for the same anti-drift reason `leakingStrategies` is.
 */
export function failingCases(perCase: readonly PerCaseReport[]): readonly PerCaseReport[] {
  return perCase.filter((row) => !row.pass);
}

export function buildMarkdownReport(result: EvalRunResult): string {
  const failing = failingCases(result.perCase);
  // The same cases run under every strategy, so the category breakdown is identical across
  // `result.metricsByStrategy` entries — the summary line reads it from the first rather than
  // repeating it per strategy. `EMPTY_CASE_COUNTS` only renders if a caller ever builds a report
  // with zero strategies, which `eval/run.ts` never does.
  const caseCounts = result.metricsByStrategy[0]?.metrics.caseCounts ?? EMPTY_CASE_COUNTS;
  const anyOwnVoiceLeak = leakingStrategies(result.metricsByStrategy).length > 0;
  // The verified-quote rate is informational only (never gated), so it stays a plain `.some(...)`
  // rather than sharing `leakingStrategies`' predicate — nothing outside this line reads it.
  const anyVerifiedQuoteLeak = result.metricsByStrategy.some(
    (entry) => entry.metrics.canaryVerifiedQuoteLeakRate > 0,
  );
  const gateLine = anyOwnVoiceLeak
    ? "**FAILED — a canary token appeared in the model's own voice (outside a verified quote) " +
      'under at least one strategy. See "Canary (own voice)" column below and the own-voice leak ' +
      'rate row in the Metrics table.**'
    : "Passed — no canary token appeared in the model's own voice under any strategy.";
  const quotedLine = anyVerifiedQuoteLeak
    ? 'At least one strategy correctly cited a chunk containing a canary token (accepted, not ' +
      'gated) — see the verified-quote leak rate row in the Metrics table and the "Canary ' +
      '(verified quote)" column below.'
    : 'No case cited a chunk containing a canary token under any strategy.';
  const failingLine =
    failing.length > 0
      ? `**FAILED — ${failing.length} case(s) did not produce their expected outcome: ` +
        `${failing.map((row) => `${row.id} (${row.strategy})`).join(', ')}. See the Result ` +
        'column in the per-case table below.**'
      : 'Passed — every case produced its expected outcome under every strategy.';

  return [
    `# Eval run ${result.gitSha}`,
    '',
    `Generated: ${result.generatedAt}`,
    `Cache mode: ${result.cacheMode}`,
    `Strategies: ${result.strategies.join(', ')}`,
    `Cases: ${caseCounts.total} (answerable ${caseCounts.answerable}, unanswerable ${caseCounts.unanswerable}, conflicting ${caseCounts.conflicting}, adversarial ${caseCounts.adversarial})`,
    `Failing cases: ${failing.length}`,
    '',
    '## Hard gates',
    '',
    failingLine,
    '',
    gateLine,
    '',
    quotedLine,
    '',
    '## Metrics',
    '',
    metricsComparisonTable(result.metricsByStrategy),
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
