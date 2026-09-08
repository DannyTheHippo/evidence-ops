import type { EvalCategory, EvalOutcome } from './dataset/schema';
import type { EvalLane } from './lanes';
import type { BaselineComparison } from './metrics/compare-baseline';
import type { CaseOutcomeKind, EvalMetrics } from './metrics/compute-metrics';
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

/**
 * How many of the tenant's pdf-page/docx-paragraph chunks `locator-overlap.ts`'s
 * `classifyOverlapScoringMethod` puts on each side of its element-index/text-containment split
 * (see that function's doc comment). Corpus-level, not per-case — re-ingesting is opt-in
 * (`--ingest`), so one eval run can span chunks written under both the old and new shape.
 *
 * Feeds the conflict-scope check's chunk resolution only (`corpusChunkById`, via
 * `conflictValuesOverlapExpectedLocators`) — recall and citation precision always score via
 * text-containment regardless of this split, because their own candidates never carry `elements`.
 */
export interface ScoringMethodSplit {
  readonly elementIndexChunks: number;
  readonly textContainmentChunks: number;
}

/** Every `EvalMetrics` leaf a lane's `bars.json` can register a hard bar against — the public
 * lane's counterpart to the synthetic lane's fixed floor constants below, sourced from a tracked
 * file instead so the bound and its provenance (`LaneBars.registeredIn`) travel together. */
export type BarMetric =
  | 'recallAt5'
  | 'recallAt10'
  | 'mrr'
  | 'citationPrecision'
  | 'claimCoverageMean'
  | 'abstentionAccuracy'
  | 'conflictRecall'
  | 'conflictScopeAccuracy'
  | 'answerContentAccuracy'
  | 'answerRate'
  | 'canaryOwnVoiceLeakRate';

/** The shape of a lane's tracked `bars.json` — `eval/public/bars.json` for the public lane. */
export interface LaneBars {
  /** Path to the ADR that pre-registered these bounds (`docs/adr/0031-…`) — carried so a reader of
   * a result file can trace a bound back to where it was fixed, before any run existed to tempt it. */
  readonly registeredIn: string;
  readonly hard: Partial<Record<BarMetric, { readonly min?: number; readonly max?: number }>>;
  /** Metrics measured on this lane but not gated by it — printed in the report, never checked
   * against a bound. */
  readonly reported: readonly string[];
  readonly datasetMinimums: Record<string, number>;
}

export interface BarOutcome {
  readonly metric: BarMetric;
  readonly observed: number;
  readonly bound: { readonly min?: number; readonly max?: number };
  readonly met: boolean;
}

function barMetricValue(metrics: EvalMetrics, metric: BarMetric): number {
  switch (metric) {
    case 'recallAt5':
      return metrics.retrieval.recallAt5;
    case 'recallAt10':
      return metrics.retrieval.recallAt10;
    case 'mrr':
      return metrics.retrieval.mrr;
    case 'citationPrecision':
      return metrics.citationPrecision;
    case 'claimCoverageMean':
      return metrics.claimCoverageMean;
    case 'abstentionAccuracy':
      return metrics.abstentionAccuracy;
    case 'conflictRecall':
      return metrics.conflictRecall;
    case 'conflictScopeAccuracy':
      return metrics.conflictScopeAccuracy;
    case 'answerContentAccuracy':
      return metrics.answerContentAccuracy;
    case 'answerRate':
      return metrics.answerRate;
    case 'canaryOwnVoiceLeakRate':
      return metrics.canaryOwnVoiceLeakRate;
  }
}

/**
 * Reads every hard bar in `bars.hard` against `metrics`, one `BarOutcome` per bar — the public
 * lane's counterpart to the synthetic lane's fixed floors (`RECALL_AT_5_FLOOR` etc., below). A
 * bound with both `min` and `max` absent can never fail to match `bars.json`'s own shape, but
 * `met` is still computed generically rather than assuming one direction, so a future bar with
 * only a `max` (a leak rate) and one with only a `min` (a recall floor) share the same evaluation.
 */
export function evaluateBars(metrics: EvalMetrics, bars: LaneBars): readonly BarOutcome[] {
  return (Object.entries(bars.hard) as readonly [BarMetric, { min?: number; max?: number }][]).map(
    ([metric, bound]) => {
      const observed = barMetricValue(metrics, metric);
      const met =
        (bound.min === undefined || observed >= bound.min) &&
        (bound.max === undefined || observed <= bound.max);
      return { metric, observed, bound, met };
    },
  );
}

/** Whether any bar in `outcomes` was missed — the one predicate `eval/run.ts` sets
 * `process.exitCode = 1` on for a lane scored against `bars.json`, and `buildMarkdownReport`'s
 * "## Pre-registered bars" section reads for the same anti-drift reason `hasOwnVoiceLeak` etc. do. */
export function hasMissedBar(outcomes: readonly BarOutcome[]): boolean {
  return outcomes.some((outcome) => !outcome.met);
}

export interface EvalRunResult {
  readonly gitSha: string;
  readonly generatedAt: string;
  readonly lane: EvalLane;
  readonly cacheMode: EvalCacheMode;
  /** sha256 over the tenant's sorted `evidence_chunks._id` values at run time — what a replay
   * asserts against the value recorded in `eval/cache/manifest.json` (see `run.ts`). Carried in
   * the JSON report as run provenance; not rendered into the markdown table, which is about case
   * outcomes, not cache bookkeeping. */
  readonly corpusFingerprint: string;
  /** sha256 over the dataset file's bytes at run time — what a lane with a `datasetManifestPath`
   * asserts against `manifest.json`'s `casesSha256` before any case runs (`eval/run.ts`). */
  readonly datasetFingerprint: string;
  readonly metrics: EvalMetrics;
  readonly perCase: readonly PerCaseReport[];
  readonly scoringMethodSplit: ScoringMethodSplit;
  /** Set together — present exactly when `--compare <path>` was passed. `baselinePath` is the
   * resolved path so the markdown section and the JSON report can name what they compared
   * against. */
  readonly baselineComparison?: BaselineComparison;
  readonly baselinePath?: string;
  /** Present exactly on a lane with a `barsPath` (`eval/run.ts`'s `laneConfig`) — the outcome of
   * every hard bar in that lane's tracked `bars.json` against this run's metrics. Absent on the
   * synthetic lane, which gates on the fixed floors below instead. */
  readonly barOutcomes?: readonly BarOutcome[];
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** One row per metric, single value column — there is exactly one retrieval path now, so a
 * per-strategy comparison table would carry one column for nothing to compare against. */
function metricsTable(metrics: EvalMetrics): string {
  const row = (label: string, format: (metrics: EvalMetrics) => string): string =>
    `| ${label} | ${format(metrics)} |`;
  const tabularGroundedLabel = `**Tabular grounded rate (n=${metrics.tabularClaimCount}; hard gate vs. baseline)**`;

  const rows = [
    '| Metric | Value |',
    '| --- | --- |',
    row('**Recall@5 (hard gate, floor)**', (m) => `**${pct(m.retrieval.recallAt5)}**`),
    row('Recall@10', (m) => pct(m.retrieval.recallAt10)),
    row('MRR', (m) => m.retrieval.mrr.toFixed(3)),
    row('Citation precision (informational, not gated)', (m) => pct(m.citationPrecision)),
    row('Mean claim coverage', (m) => pct(m.claimCoverageMean)),
    row('Abstention accuracy (unanswerable)', (m) => pct(m.abstentionAccuracy)),
    row('Conflict recall (conflicting)', (m) => pct(m.conflictRecall)),
    row('Answer rate (answerable)', (m) => pct(m.answerRate)),
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
    row(tabularGroundedLabel, (m) => `**${pct(m.tabularGroundedRate)}**`),
    row('Coverage drop rate (informational, not gated)', (m) => pct(m.coverageDropRate)),
    row('Contradiction drop rate (informational, not gated)', (m) => pct(m.contradictionDropRate)),
  ];

  if (metrics.retrievalLatency) {
    const { p50Ms, p95Ms } = metrics.retrievalLatency;
    rows.push(row('Retrieval latency p50/p95 (ms)', () => `${p50Ms}/${p95Ms}`));
  }

  return rows.join('\n');
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

/**
 * Hard-gate floor for `EvalMetrics.retrieval.recallAt5` — comfortably below what the current
 * retrieval path reaches on the synthetic corpus, not the theoretical maximum: recall@5 depends on
 * chunking and embedding behaviour this dataset was never meant to hold to 100%.
 * `isBelowRecallAt5Floor` fails CLOSED below it — a drop below today's baseline is a real retrieval
 * regression, not sampling noise, since replay serves every embedding response from a committed
 * fixture. Raise it only alongside a change that legitimately improves recall; never lower it to let
 * a newly failing run pass.
 */
export const RECALL_AT_5_FLOOR = 0.8;

/**
 * Whether the run's recall@5 fell below `RECALL_AT_5_FLOOR` — the fifth hard gate, same anti-drift
 * pattern as `isBelowAnswerContentFloor`: the one predicate both `buildMarkdownReport`'s gate line
 * and `eval/run.ts`'s process exit code read.
 */
export function isBelowRecallAt5Floor(metrics: EvalMetrics): boolean {
  return metrics.retrieval.recallAt5 < RECALL_AT_5_FLOOR;
}

/**
 * Whether a `--compare` run regressed against its baseline — the sixth hard gate, gated on
 * `baselineComparison.regressions` rather than a floor: `compareToBaseline` has already resolved
 * each `GATED_METRICS` key's own direction, so any nonempty `regressions` list is a real
 * regression to fail CLOSED on. `undefined` (no `--compare` passed) never gates — same anti-drift
 * pattern as the gates above, the one predicate both `buildMarkdownReport`'s gate line and
 * `eval/run.ts`'s process exit code read.
 */
export function hasBaselineRegression(result: Pick<EvalRunResult, 'baselineComparison'>): boolean {
  return (result.baselineComparison?.regressions.length ?? 0) > 0;
}

/**
 * Informational, never gated: whether the tenant's pdf-page/docx-paragraph corpus chunks
 * (`ScoringMethodSplit`) mix both `OverlapScoringMethod`s. Describes the conflict-scope check's
 * chunk resolution only — see `ScoringMethodSplit`'s doc comment; recall and citation precision
 * always score via text-containment and a `true` result here says nothing about either of those.
 */
export function hasMixedScoringMethods(split: ScoringMethodSplit): boolean {
  return split.elementIndexChunks > 0 && split.textContainmentChunks > 0;
}

function scoringMethodLine(split: ScoringMethodSplit): string {
  const total = split.elementIndexChunks + split.textContainmentChunks;
  if (total === 0) {
    return 'No pdf-page/docx-paragraph chunks under this tenant.';
  }
  const counts =
    `${split.elementIndexChunks} chunk(s) scored by exact element-index equality, ` +
    `${split.textContainmentChunks} chunk(s) fell back to text-containment ` +
    `(${total} pdf/docx chunk(s) total).`;
  const scopeNote =
    "This split describes the conflict-scope check's chunk resolution only — recall and " +
    'citation precision always score via text-containment, independent of this split (their ' +
    'candidates never carry retained elements).';
  return hasMixedScoringMethods(split)
    ? `**Mixed run** — ${counts} ${scopeNote} Re-ingest with \`--ingest\` so every chunk carries ` +
        'retained elements before comparing the conflict-scope check against a single-method run.'
    : `${counts} ${scopeNote}`;
}

/** Empty when `baselineComparison`/`baselinePath` are absent (no `--compare` passed) — the
 * section itself must not render at all in that case, not render with empty contents. */
function baselineComparisonSection(result: EvalRunResult): string[] {
  const comparison = result.baselineComparison;
  if (!comparison || result.baselinePath === undefined) {
    return [];
  }
  const regressionLine = hasBaselineRegression(result)
    ? `**FAILED — ${comparison.regressions.length} metric(s) regressed against ` +
      `${result.baselinePath}: ` +
      comparison.regressions.map((r) => `${r.metric} ${r.baseline}→${r.current}`).join(', ') +
      '.**'
    : `Passed — no gated metric regressed against ${result.baselinePath}.`;

  return [
    '## Baseline comparison',
    '',
    `Baseline: ${result.baselinePath}`,
    '',
    regressionLine,
    '',
    `Held: ${comparison.held.length}`,
    `Absent from baseline: ${comparison.absentFromBaseline.length > 0 ? comparison.absentFromBaseline.join(', ') : 'none'}`,
    `Absent from current: ${comparison.absentFromCurrent.length > 0 ? comparison.absentFromCurrent.join(', ') : 'none'}`,
    '',
  ];
}

function formatBarBound(bound: { readonly min?: number; readonly max?: number }): string {
  return [
    bound.min === undefined ? undefined : `min=${bound.min}`,
    bound.max === undefined ? undefined : `max=${bound.max}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}

/** One MET/MISSED line per bar — the markdown counterpart to the `eval: bar …` lines
 * `eval/run.ts` prints for the same `BarOutcome[]`. */
function barOutcomeLine(outcome: BarOutcome): string {
  return (
    `- \`${outcome.metric}\`: ${outcome.met ? 'MET' : '**MISSED**'} — observed ` +
    `${outcome.observed}, bound ${formatBarBound(outcome.bound)}`
  );
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
  const belowRecallAt5Floor = isBelowRecallAt5Floor(result.metrics);
  const recallAt5Line = belowRecallAt5Floor
    ? `**FAILED — recall@5 ${pct(result.metrics.retrieval.recallAt5)} is below the ` +
      `${pct(RECALL_AT_5_FLOOR)} floor. See the Recall@5 row in the Metrics table.**`
    : 'Passed — recall@5 is at or above the floor.';

  // A lane with `barOutcomes` (the public lane) is scored against pre-registered bars instead of
  // the fixed floors above — the synthetic lane's own section is unchanged either way.
  const gatesOrBarsSection: readonly string[] =
    result.barOutcomes === undefined
      ? [
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
          recallAt5Line,
          '',
        ]
      : ['## Pre-registered bars', '', ...result.barOutcomes.map(barOutcomeLine), ''];

  return [
    `# Eval run ${result.gitSha}`,
    '',
    `Generated: ${result.generatedAt}`,
    `Cache mode: ${result.cacheMode}`,
    `Cases: ${caseCounts.total} (answerable ${caseCounts.answerable}, unanswerable ${caseCounts.unanswerable}, conflicting ${caseCounts.conflicting}, adversarial ${caseCounts.adversarial})`,
    `Failing cases: ${failing.length}`,
    '',
    ...gatesOrBarsSection,
    '## Metrics',
    '',
    metricsTable(result.metrics),
    '',
    ...baselineComparisonSection(result),
    '## Conflict-scope check scoring method',
    '',
    scoringMethodLine(result.scoringMethodSplit),
    '',
    '## Per-case results',
    '',
    perCaseTable(result.perCase),
    '',
  ].join('\n');
}
