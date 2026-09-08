import type { EvalCacheMode } from '../bootstrap';
import {
  CITATION_STABILITY_BAR,
  type CaseVariance,
  type VarianceAggregate,
  type VarianceObservation,
} from './aggregate-variance';
import type { VarianceProgress } from './variance-resume';

/**
 * One question's full record on one pass. Wider than `VarianceObservation` — which carries only the
 * three figures the bars are scored on — because the retrieved pool and the exact quotes are what
 * let a later reader tell a retrieval drift apart from the model choosing differently out of an
 * identical pool, and a live pass is too expensive to re-run to recover them.
 */
export interface VarianceCaseRun extends VarianceObservation {
  readonly question: string;
  readonly retrievedChunkIds: readonly string[];
  readonly citations: readonly { readonly chunkId: string; readonly quote: string }[];
}

export interface VarianceRunResult extends VarianceProgress {
  readonly generatedAt: string;
  /** Complete passes — a pass counts only once every case in it has been observed, so a lane stopped
   * mid-pass by the spend ceiling or a crash still leaves a complete report over the passes that did
   * finish rather than nothing at all. */
  readonly runCount: number;
  readonly modelCacheMode: EvalCacheMode;
  readonly embeddingCacheMode: EvalCacheMode;
  /** Absent until at least one pass is complete — `aggregateVariance` throws on a case missing a
   * pass (`aggregate-variance.ts:157-169`), and the file is written after every observed case, so it
   * can be read back mid-pass with no complete pass to aggregate yet. */
  readonly aggregate?: VarianceAggregate;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Chunk ids are 64-char content hashes; the first 8 hex characters separate every chunk in this
 * corpus and keep the raw table readable. The JSON report carries them in full. */
const shortId = (chunkId: string): string => chunkId.slice(0, 8);

function citationSetCell(citationSetKey: string): string {
  if (citationSetKey === '') {
    return '-';
  }
  return citationSetKey.split(',').map(shortId).join(' ');
}

function summaryTable(aggregate: VarianceAggregate, requestedRunCount: number): string {
  const { summary } = aggregate;
  const rate = summary.citationStabilityRate;
  return [
    '| Figure | Value |',
    '| --- | --- |',
    `| Passes | ${summary.runCount} of ${requestedRunCount} requested |`,
    `| Questions | ${summary.caseCount} |`,
    `| Questions reaching a safety outcome in any pass | ${summary.safetyOutcomeCaseCount} |`,
    `| **Outcome flips (primary bar: 0)** | **${summary.flippedCaseIds.length}** |`,
    `| Questions answered in every pass | ${summary.answeredEveryRunCaseCount} |`,
    `| Of those, identical citation set in every pass | ${summary.citationStableCaseCount} |`,
    `| **Citation-set stability (secondary bar: ≥ ${pct(CITATION_STABILITY_BAR)})** | **${rate === null ? 'not evaluable' : pct(rate)}** |`,
  ].join('\n');
}

function perCaseTable(perCase: readonly CaseVariance[]): string {
  const rows = perCase.map((row) => {
    const spread = row.claimCountSpread;
    return (
      `| ${row.caseId} | ${row.distinctOutcomeKinds.join(', ')} | ` +
      `${row.outcomeFlipped ? '**FLIP**' : '-'} | ${row.distinctCitationSets} | ` +
      `${row.citationSetStable === null ? '-' : row.citationSetStable ? 'stable' : 'DIFFERS'} | ` +
      `${spread.min}/${spread.max}/${spread.mode} |`
    );
  });
  return [
    '| Case | Outcome kinds seen | Flip | Distinct citation sets | Citation set | Claims min/max/mode |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** One row per question per pass — the measurement itself, not a reduction of it: a summary that
 * hides which question moved cannot be checked by whoever reads this next. */
function rawTable(perCase: readonly CaseVariance[]): string {
  const rows = perCase.flatMap((row) =>
    row.runs.map(
      (point) =>
        `| ${row.caseId} | ${point.runIndex} | ${point.outcomeKind} | ${point.claimCount} | ` +
        `${citationSetCell(point.citationSetKey)} |`,
    ),
  );
  return [
    '| Case | Pass | Outcome | Claims | Cited chunks |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Header shared by a complete and an in-progress report: the two fingerprints a resume is checked
 * against, and one line per pass naming the sha it ran under and when it started. */
function headerLines(result: VarianceRunResult): readonly string[] {
  return [
    `# Variance run ${result.baseGitSha}`,
    '',
    `Generated: ${result.generatedAt}`,
    `Passes: ${result.runCount} of ${result.requestedRunCount} requested`,
    `Model cache: ${result.modelCacheMode} (every model call live)`,
    `Embedding cache: ${result.embeddingCacheMode}`,
    `Corpus fingerprint: ${result.corpusFingerprint}`,
    `Dataset fingerprint: ${result.datasetFingerprint}`,
    '',
    ...result.passLabels.map(
      (label) => `Pass ${label.runIndex}: ${label.gitSha} (${label.startedAt})`,
    ),
  ];
}

export function buildVarianceMarkdownReport(result: VarianceRunResult): string {
  const aggregate = result.aggregate;
  if (aggregate === undefined) {
    return [
      ...headerLines(result),
      '',
      'No pass has completed yet — the bars, summary and per-question tables need at least one ' +
        'complete pass to aggregate over.',
      '',
    ].join('\n');
  }

  const { summary } = aggregate;
  const primaryLine = summary.primaryBarMet
    ? 'Met — every question reaching a safety outcome reached the same one in every pass.'
    : `**MISSED — ${summary.flippedCaseIds.length} question(s) changed outcome kind: ` +
      `${summary.flippedCaseIds.join(', ')}. See the Flip column below.**`;
  const rate = summary.citationStabilityRate;
  const secondaryLine =
    rate === null
      ? '**Not evaluable — no question was answered in every pass, so the bar has an empty ' +
        'denominator.**'
      : summary.secondaryBarMet === true
        ? `Met — ${summary.citationStableCaseCount} of ${summary.answeredEveryRunCaseCount} ` +
          `questions answered in every pass cited an identical set (${pct(rate)}).`
        : `**MISSED — ${summary.citationStableCaseCount} of ${summary.answeredEveryRunCaseCount} ` +
          `questions answered in every pass cited an identical set (${pct(rate)}), below the ` +
          `${pct(CITATION_STABILITY_BAR)} bar.**`;

  return [
    ...headerLines(result),
    '',
    '## Bars',
    '',
    `**Primary — abstention stability (zero flips).** ${primaryLine}`,
    '',
    `**Secondary — evidence stability (≥ ${pct(CITATION_STABILITY_BAR)} identical citation sets).** ${secondaryLine}`,
    '',
    'A citation set is the deduped, sorted set of cited `chunkId`s — the identity of the evidence ' +
      'shown, not its phrasing; quote spans are excluded. The denominator is the questions answered ' +
      'in every pass, since a question that flipped has no comparable set to hold stable.',
    '',
    '**Claim-count spread is reported without a bar.**',
    '',
    '## Summary',
    '',
    summaryTable(aggregate, result.requestedRunCount),
    '',
    '## Per-question spread',
    '',
    perCaseTable(aggregate.perCase),
    '',
    '## Raw — one row per question per pass',
    '',
    'Cited chunks are the first 8 characters of each `chunkId`; the JSON report carries them in ' +
      'full, alongside the retrieved pool and the verified quotes.',
    '',
    rawTable(aggregate.perCase),
    '',
  ].join('\n');
}
