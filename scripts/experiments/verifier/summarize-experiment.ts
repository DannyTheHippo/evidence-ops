import type { AdjudicationRow, AdjudicationSample, VerdictBreakdown } from './types';
import {
  BAR_1_MIN_GATE_FAILURE_RATE,
  BAR_2_MIN_CORRECT_CATCH_RATE,
  evaluateBar,
  gateFailureRate,
  type BarResult,
} from './verdict-metrics';

/** The run-level facts a summary needs, as `run.json` persists them. */
export interface SummaryInput {
  readonly runId: string;
  readonly gitSha: string;
  readonly tenantId: string;
  readonly totalClaims: number;
  readonly breakdown: VerdictBreakdown;
  readonly sample: AdjudicationSample;
  readonly rows: readonly AdjudicationRow[];
}

export interface ExperimentSummary {
  readonly runId: string;
  readonly gitSha: string;
  readonly tenantId: string;
  readonly totalClaims: number;
  readonly breakdown: VerdictBreakdown;
  readonly gateFailureCount: number;
  readonly bar1: BarResult;
  readonly sample: AdjudicationSample;
  readonly correctCatchCount: number;
  readonly falseCatchCount: number;
  /** Sampled claims with no adjudication yet, by id — the reason `bar2` can be `null`. */
  readonly unfilledClaimIds: readonly string[];
  /** Worksheet sections carrying a claim id that was never sampled. */
  readonly unknownClaimIds: readonly string[];
  /** `null` while any sampled claim is unadjudicated: a rate over part of the sample is not the
   *  pre-registered rate, and reporting one would be the reframing the registration forbids. */
  readonly bar2: BarResult | null;
}

/**
 * Computes both pre-registered rates from a run's verdicts and its hand-filled worksheet.
 *
 * Bar 1 is always computable — it needs only the verdicts. Bar 2 is withheld (`null`) until every
 * sampled claim carries an adjudication, and the ids still outstanding are named so the gap is
 * actionable rather than silently rounded away.
 */
export function summarizeExperiment(input: SummaryInput): ExperimentSummary {
  const gateFailureCount = input.breakdown.not_grounded + input.breakdown.no_evidence_retrieved;
  const bar1 = evaluateBar(gateFailureRate(input.breakdown), BAR_1_MIN_GATE_FAILURE_RATE);

  const sampledIds = new Set(input.sample.claimIds);
  const rowByClaimId = new Map(input.rows.map((row) => [row.claimId, row]));
  const unknownClaimIds = input.rows
    .filter((row) => !sampledIds.has(row.claimId))
    .map((row) => row.claimId);

  const adjudicated = input.sample.claimIds
    .map((claimId) => rowByClaimId.get(claimId)?.adjudication ?? null)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const unfilledClaimIds = input.sample.claimIds.filter(
    (claimId) => (rowByClaimId.get(claimId)?.adjudication ?? null) === null,
  );

  const correctCatchCount = adjudicated.filter((value) => value === 'correct_catch').length;
  const falseCatchCount = adjudicated.filter((value) => value === 'false_catch').length;

  const bar2 =
    unfilledClaimIds.length > 0 || adjudicated.length === 0
      ? null
      : evaluateBar(correctCatchCount / adjudicated.length, BAR_2_MIN_CORRECT_CATCH_RATE);

  return {
    runId: input.runId,
    gitSha: input.gitSha,
    tenantId: input.tenantId,
    totalClaims: input.totalClaims,
    breakdown: input.breakdown,
    gateFailureCount,
    bar1,
    sample: input.sample,
    correctCatchCount,
    falseCatchCount,
    unfilledClaimIds,
    unknownClaimIds,
    bar2,
  };
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatBar(label: string, question: string, bar: BarResult | null): readonly string[] {
  if (!bar) {
    return [
      `## ${label} — NOT EVALUATED`,
      '',
      question,
      '',
      'The sample is not fully adjudicated. No rate is reported.',
      '',
    ];
  }
  return [
    `## ${label} — ${bar.met ? 'MET' : 'MISSED'}`,
    '',
    question,
    '',
    `Observed ${formatPercent(bar.observed)} against a minimum of ${formatPercent(bar.threshold)}.`,
    '',
  ];
}

/** Renders the summary as the result section a reader compares against the pre-registration. */
export function renderSummaryMarkdown(summary: ExperimentSummary): string {
  const lines: string[] = [
    '# Result — verifier experiment (step 10b)',
    '',
    `Pre-registration and results: \`docs/adr/0024-what-the-first-measurements-say.md\`.`,
    '',
    `- Run: \`${summary.runId}\``,
    `- Git sha: \`${summary.gitSha}\``,
    `- Tenant: \`${summary.tenantId}\``,
    `- Claims drafted: ${summary.totalClaims}`,
    '',
    '## Verdicts',
    '',
    `- grounded: ${summary.breakdown.grounded}`,
    `- not_grounded: ${summary.breakdown.not_grounded}`,
    `- no_evidence_retrieved: ${summary.breakdown.no_evidence_retrieved}`,
    `- conflicting_evidence: ${summary.breakdown.conflicting_evidence}`,
    `- gate failures (not_grounded + no_evidence_retrieved): ${summary.gateFailureCount}`,
    '',
    ...formatBar('Bar 1', 'Minimum 20% of drafted claims fail the gate.', summary.bar1),
    ...formatBar('Bar 2', 'Minimum 70% of adjudicated failures are correct catches.', summary.bar2),
    '## Adjudication',
    '',
    `- Sampled: ${summary.sample.claimIds.length} of ${summary.sample.populationSize} gate failures (seed ${summary.sample.seed})`,
    `- correct_catch: ${summary.correctCatchCount}`,
    `- false_catch: ${summary.falseCatchCount}`,
    `- unadjudicated: ${summary.unfilledClaimIds.length}`,
    '',
  ];

  if (summary.unfilledClaimIds.length > 0) {
    lines.push(
      `Unadjudicated claims: ${summary.unfilledClaimIds.map((id) => `\`${id}\``).join(', ')}`,
      '',
    );
  }
  if (summary.unknownClaimIds.length > 0) {
    lines.push(
      `Worksheet sections for claims that were never sampled: ` +
        `${summary.unknownClaimIds.map((id) => `\`${id}\``).join(', ')}`,
      '',
    );
  }

  lines.push(
    `Sampled claim ids: ${summary.sample.claimIds.map((id) => `\`${id}\``).join(', ')}`,
    '',
  );

  return lines.join('\n');
}
