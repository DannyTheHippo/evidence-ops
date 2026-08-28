import type { CaseOutcomeKind } from '../metrics/compute-metrics';

/**
 * The two outcome kinds that are safety outcomes: refusing to answer, and declaring that the
 * sources disagree. A question reaching either one in any pass must reach the same one in every
 * pass — see `CaseVariance.outcomeFlipped`.
 */
const SAFETY_OUTCOME_KINDS: readonly CaseOutcomeKind[] = [
  'insufficient_evidence',
  'conflicting_evidence',
];

/** Share of answered-every-pass questions that must show an identical citation set. */
export const CITATION_STABILITY_BAR = 0.9;

/**
 * One question's result on one pass of the variance lane, reduced to the three things the lane
 * measures. `eval/run.ts` is what produces these from a live pass, so this module stays pure and
 * testable without a model call.
 */
export interface VarianceObservation {
  readonly runIndex: number;
  readonly caseId: string;
  readonly outcomeKind: CaseOutcomeKind;
  /** `chunkId` of every citation on a gate-verified claim, in the order they were cited; deduped
   * and sorted into a comparable key by `citationSetKey`. Empty when the outcome carries no
   * citations. */
  readonly citedChunkIds: readonly string[];
  readonly claimCount: number;
}

export interface CaseRunPoint {
  readonly runIndex: number;
  readonly outcomeKind: CaseOutcomeKind;
  /** Distinct cited `chunkId`s, sorted and joined — the identity of the evidence shown, not its
   * phrasing: quote spans are deliberately excluded, so a differing paraphrase over the same chunks
   * counts as the same citation set. Empty string when nothing was cited. */
  readonly citationSetKey: string;
  readonly claimCount: number;
}

export interface ClaimCountSpread {
  readonly min: number;
  readonly max: number;
  /** Most frequent claim count across the passes; ties resolve to the smallest tied value. */
  readonly mode: number;
}

export interface CaseVariance {
  readonly caseId: string;
  readonly runs: readonly CaseRunPoint[];
  /** Outcome kinds the question reached, in first-seen order. */
  readonly distinctOutcomeKinds: readonly CaseOutcomeKind[];
  /** Whether any pass produced a safety outcome — what puts the question in the primary bar's
   * denominator. */
  readonly touchedSafetyOutcome: boolean;
  /** A safety-outcome question that did not reach the same kind in every pass. */
  readonly outcomeFlipped: boolean;
  readonly answeredEveryRun: boolean;
  readonly distinctCitationSets: number;
  /** `null` — a third state, not `false` — when the question was not answered in every pass: there
   * is no comparable citation set to hold stable, and the instability is already counted as a flip. */
  readonly citationSetStable: boolean | null;
  readonly claimCountSpread: ClaimCountSpread;
}

export interface VarianceSummary {
  readonly runCount: number;
  readonly caseCount: number;
  readonly safetyOutcomeCaseCount: number;
  readonly flippedCaseIds: readonly string[];
  readonly primaryBarMet: boolean;
  readonly answeredEveryRunCaseCount: number;
  readonly citationStableCaseCount: number;
  /** `null` when no question was answered in every pass — the bar has an empty denominator and is
   * not evaluable, which is reported as such rather than rounded up to a pass. */
  readonly citationStabilityRate: number | null;
  readonly secondaryBarMet: boolean | null;
}

export interface VarianceAggregate {
  readonly summary: VarianceSummary;
  readonly perCase: readonly CaseVariance[];
}

/**
 * Deduped and sorted, so neither the order two claims happened to cite their chunks in nor a chunk
 * cited twice makes two otherwise-identical answers look like different evidence.
 */
export function citationSetKey(citedChunkIds: readonly string[]): string {
  return [...new Set(citedChunkIds)].sort().join(',');
}

/** Most frequent value; a tie resolves to the smallest tied value so the figure is reproducible. */
function mode(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function caseVariance(caseId: string, rows: readonly VarianceObservation[]): CaseVariance {
  const runs: readonly CaseRunPoint[] = rows.map((row) => ({
    runIndex: row.runIndex,
    outcomeKind: row.outcomeKind,
    citationSetKey: citationSetKey(row.citedChunkIds),
    claimCount: row.claimCount,
  }));
  const distinctOutcomeKinds = [...new Set(runs.map((row) => row.outcomeKind))];
  const touchedSafetyOutcome = runs.some((row) => SAFETY_OUTCOME_KINDS.includes(row.outcomeKind));
  const answeredEveryRun = runs.every((row) => row.outcomeKind === 'answered');
  const claimCounts = runs.map((row) => row.claimCount);

  return {
    caseId,
    runs,
    distinctOutcomeKinds,
    touchedSafetyOutcome,
    // A question that never reached a safety outcome cannot flip out of one, so it stays out of the
    // primary bar's denominator no matter how its answers differ.
    outcomeFlipped: touchedSafetyOutcome && distinctOutcomeKinds.length > 1,
    answeredEveryRun,
    distinctCitationSets: new Set(runs.map((row) => row.citationSetKey)).size,
    citationSetStable: answeredEveryRun
      ? new Set(runs.map((row) => row.citationSetKey)).size === 1
      : null,
    claimCountSpread: {
      min: Math.min(...claimCounts),
      max: Math.max(...claimCounts),
      mode: mode(claimCounts),
    },
  };
}

/**
 * Reduces the raw per-question-per-pass observations to the three figures the variance lane
 * reports: outcome flips, citation-set stability, and claim-count spread.
 *
 * Refuses an incomplete measurement rather than aggregating around it — a question missing a pass
 * would silently narrow its own spread, which is the one direction a variance figure must never
 * drift. Fails CLOSED for that reason; it is not a gate on the system under test, so the caller
 * reports a missed bar rather than failing on it.
 */
export function aggregateVariance(
  observations: readonly VarianceObservation[],
  runCount: number,
): VarianceAggregate {
  if (observations.length === 0) {
    throw new Error('aggregateVariance: no observations to aggregate');
  }

  const perCase = [...new Set(observations.map((row) => row.caseId))].map((caseId) => {
    const rows = observations.filter((row) => row.caseId === caseId);
    const observedRuns = new Set(rows.map((row) => row.runIndex));
    if (observedRuns.size !== runCount) {
      throw new Error(
        `aggregateVariance: case '${caseId}' has ${observedRuns.size} distinct pass(es), ` +
          `expected ${runCount}`,
      );
    }
    return caseVariance(caseId, rows);
  });

  const flippedCaseIds = perCase.filter((row) => row.outcomeFlipped).map((row) => row.caseId);
  const answeredEveryRun = perCase.filter((row) => row.answeredEveryRun);
  const citationStableCaseCount = answeredEveryRun.filter(
    (row) => row.citationSetStable === true,
  ).length;
  const citationStabilityRate =
    answeredEveryRun.length === 0 ? null : citationStableCaseCount / answeredEveryRun.length;

  return {
    summary: {
      runCount,
      caseCount: perCase.length,
      safetyOutcomeCaseCount: perCase.filter((row) => row.touchedSafetyOutcome).length,
      flippedCaseIds,
      primaryBarMet: flippedCaseIds.length === 0,
      answeredEveryRunCaseCount: answeredEveryRun.length,
      citationStableCaseCount,
      citationStabilityRate,
      secondaryBarMet:
        citationStabilityRate === null ? null : citationStabilityRate >= CITATION_STABILITY_BAR,
    },
    perCase,
  };
}
