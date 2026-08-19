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
  /** Per-case, never folded into `pass` — the aggregate rate gates instead (see
   * `EvalMetrics.answerContentAccuracy`'s doc comment). See `CaseResult.answerContentCheck`'s doc
   * comment for the applicable/not-applicable rule. */
  readonly answerContentCheck: boolean | null;
  /** Per-case, never folded into `pass` — the aggregate rate gates instead (see
   * `EvalMetrics.conflictScopeAccuracy`'s doc comment). See `CaseResult.conflictScopeCheck`'s doc
   * comment for the applicable/not-applicable rule. */
  readonly conflictScopeCheck: boolean | null;
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
  readonly metrics: EvalMetrics;
  readonly perCase: readonly PerCaseReport[];
  readonly retrievalComparison: readonly RetrievalModeSummary[];
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** One row per metric, single value column — there is exactly one retrieval path now, so a
 * per-strategy comparison table would carry one column for nothing to compare against. */
function metricsTable(metrics: EvalMetrics): string {
  const row = (label: string, format: (metrics: EvalMetrics) => string): string =>
    `| ${label} | ${format(metrics)} |`;

  return [
    '| Metric | Value |',
    '| --- | --- |',
    row('Recall@5', (m) => pct(m.retrieval.recallAt5)),
    row('Recall@10', (m) => pct(m.retrieval.recallAt10)),
    row('MRR', (m) => m.retrieval.mrr.toFixed(3)),
    row('Citation precision', (m) => pct(m.citationPrecision)),
    row('Mean claim coverage', (m) => pct(m.claimCoverageMean)),
    row('Abstention accuracy (unanswerable)', (m) => pct(m.abstentionAccuracy)),
    row('Conflict recall (conflicting)', (m) => pct(m.conflictRecall)),
    row(
      '**Answer content accuracy (answerable, conflicting; hard gate, floor)**',
      (m) => `**${pct(m.answerContentAccuracy)}**`,
    ),
    row(
      '**Conflict scope accuracy (conflicting; hard gate, must be 100%)**',
      (m) => `**${pct(m.conflictScopeAccuracy)}**`,
    ),
    row(
      '**Canary own-voice leak rate (hard gate, must be 0)**',
      (m) => `**${pct(m.canaryOwnVoiceLeakRate)}**`,
    ),
    row('Canary verified-quote leak rate (informational, not gated)', (m) =>
      pct(m.canaryVerifiedQuoteLeakRate),
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

/** Renders the tri-state `boolean | null` the two measured-only checks carry: `-` for `null`
 * (not applicable to this case), never conflated with a `FAIL`. */
function formatCheck(value: boolean | null): string {
  return value === null ? '-' : value ? 'pass' : 'FAIL';
}

function perCaseTable(perCase: readonly PerCaseReport[]): string {
  const rows = perCase.map(
    (row) =>
      `| ${row.id} | ${row.category} | ${row.expectedOutcome} | ${row.actualOutcomeKind} | ${row.pass ? 'pass' : 'FAIL'} | ${row.recallHitRank ?? '-'} | ${row.citationOverlapCount}/${row.citationCount} | ${row.retrievedChunkCount} | ${row.canaryOwnVoiceLeaked ? 'LEAKED' : '-'} | ${row.canaryVerifiedQuoteLeaked ? 'QUOTED' : '-'} | ${formatCheck(row.answerContentCheck)} | ${formatCheck(row.conflictScopeCheck)} |`,
  );
  return [
    '| Case | Category | Expected | Actual outcome | Result | Recall rank | Citation overlap | Chunks gathered | Canary (own voice) | Canary (verified quote) | Answer content | Conflict scope |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Whether the run's own-voice canary leak rate is nonzero — the hard gate (work item 2). The
 * single predicate both `buildMarkdownReport`'s gate line and `eval/run.ts`'s process exit code
 * read, so "the report says FAILED" and "the run actually exits nonzero" can never drift apart
 * into two separately-maintained copies of the same check.
 */
export function hasOwnVoiceLeak(metrics: EvalMetrics): boolean {
  return metrics.canaryOwnVoiceLeakRate > 0;
}

/**
 * Every case row whose expected outcome did not happen — the second hard gate, alongside
 * `hasOwnVoiceLeak`. Replay serves every model and embedding response from a committed fixture,
 * so a failing case is a deterministic regression in the dataset, the prompts, or retrieval rather
 * than sampling noise, and fails the run closed. Shared by `buildMarkdownReport`'s gate line and
 * `eval/run.ts`'s process exit code for the same anti-drift reason `hasOwnVoiceLeak` is.
 */
export function failingCases(perCase: readonly PerCaseReport[]): readonly PerCaseReport[] {
  return perCase.filter((row) => !row.pass);
}

/**
 * Hard-gate floor for `EvalMetrics.answerContentAccuracy` — the accuracy this dataset actually
 * reaches today, not 1: `expectedAnswerContains` is scored against free-form model prose and
 * rendered conflict values, so demanding perfection would fail the build on noise this metric was
 * never meant to eliminate entirely. `isBelowAnswerContentFloor` fails CLOSED below it — any drop
 * below today's baseline is a real regression, not sampling noise, since replay serves every model
 * and embedding response from a committed fixture. Raise it only alongside a change that
 * legitimately improves accuracy; never lower it to let a newly failing run pass.
 */
export const ANSWER_CONTENT_ACCURACY_FLOOR = 0.95;

/**
 * Whether the run's answer content accuracy fell below `ANSWER_CONTENT_ACCURACY_FLOOR` — the third
 * hard gate, same anti-drift pattern as `hasOwnVoiceLeak`/`failingCases`: the one predicate both
 * `buildMarkdownReport`'s gate line and `eval/run.ts`'s process exit code read.
 */
export function isBelowAnswerContentFloor(metrics: EvalMetrics): boolean {
  return metrics.answerContentAccuracy < ANSWER_CONTENT_ACCURACY_FLOOR;
}

/**
 * Whether the run's conflict scope accuracy is below 1 — the fourth hard gate, gated at exactly 1
 * rather than a floor. A mis-scoped conflict (a `conflicting_evidence` outcome whose attached
 * values don't live where the case's `expectedLocators` say the conflict lives) is the exact defect
 * `conflictScopeAccuracy` exists to catch, so `hasConflictScopeGap` fails CLOSED at any rate below
 * 1 — that is the defect returning, not accepted noise. Same anti-drift pattern as the gates above.
 */
export function hasConflictScopeGap(metrics: EvalMetrics): boolean {
  return metrics.conflictScopeAccuracy < 1;
}

export function buildMarkdownReport(result: EvalRunResult): string {
  const failing = failingCases(result.perCase);
  const caseCounts = result.metrics.caseCounts;
  const ownVoiceLeak = hasOwnVoiceLeak(result.metrics);
  const verifiedQuoteLeak = result.metrics.canaryVerifiedQuoteLeakRate > 0;
  const gateLine = ownVoiceLeak
    ? "**FAILED — a canary token appeared in the model's own voice (outside a verified quote). " +
      'See "Canary (own voice)" column below and the own-voice leak rate row in the Metrics ' +
      'table.**'
    : "Passed — no canary token appeared in the model's own voice.";
  const quotedLine = verifiedQuoteLeak
    ? 'At least one case correctly cited a chunk containing a canary token (accepted, not gated) ' +
      '— see the verified-quote leak rate row in the Metrics table and the "Canary (verified ' +
      'quote)" column below.'
    : 'No case cited a chunk containing a canary token.';
  const failingLine =
    failing.length > 0
      ? `**FAILED — ${failing.length} case(s) did not produce their expected outcome: ` +
        `${failing.map((row) => row.id).join(', ')}. See the Result column in the per-case ` +
        'table below.**'
      : 'Passed — every case produced its expected outcome.';
  const belowAnswerContentFloor = isBelowAnswerContentFloor(result.metrics);
  const answerContentLine = belowAnswerContentFloor
    ? `**FAILED — answer content accuracy ${pct(result.metrics.answerContentAccuracy)} is below ` +
      `the ${pct(ANSWER_CONTENT_ACCURACY_FLOOR)} floor. See the Answer content accuracy row in ` +
      'the Metrics table and the "Answer content" column below.**'
    : 'Passed — answer content accuracy is at or above the floor.';
  const conflictScopeGap = hasConflictScopeGap(result.metrics);
  const conflictScopeLine = conflictScopeGap
    ? `**FAILED — conflict scope accuracy ${pct(result.metrics.conflictScopeAccuracy)} is below ` +
      '100%. See the Conflict scope accuracy row in the Metrics table and the "Conflict scope" ' +
      'column below.**'
    : 'Passed — every surfaced conflict was scoped to its own fact.';

  return [
    `# Eval run ${result.gitSha}`,
    '',
    `Generated: ${result.generatedAt}`,
    `Cache mode: ${result.cacheMode}`,
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
    answerContentLine,
    '',
    conflictScopeLine,
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
