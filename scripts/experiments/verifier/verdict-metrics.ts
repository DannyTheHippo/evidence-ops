import type { ClaimVerdict } from '../../../src/features/evidence/qa/contracts/verify-claims.contract';
import type { ClaimOutcome, VerdictBreakdown } from './types';

/**
 * The two pre-registered bars. They are fixed: a run reports against these numbers or it does
 * not report.
 */
export const BAR_1_MIN_GATE_FAILURE_RATE = 0.2;
export const BAR_2_MIN_CORRECT_CATCH_RATE = 0.7;

/**
 * The verdicts that count as the gate failing a claim, and therefore both the Bar 1 numerator and
 * the population the adjudication sample is drawn from. Bound to the pre-registration's two
 * adjudication buckets rather than to the verdict named `not_grounded`: `no_evidence_retrieved`
 * lands squarely in one bucket or the other (the claim is genuinely unsupported, or the evidence
 * exists and retrieval never surfaced it — the purest form of a false catch), so excluding it would
 * drop the strongest retrieval-failure signal and bias the correct-catch rate upward.
 * `conflicting_evidence` fits neither bucket — evidence was located and mechanically verified — so
 * it is counted and reported separately, never folded into either bar.
 */
export const GATE_FAILURE_VERDICTS: readonly ClaimVerdict[] = [
  'not_grounded',
  'no_evidence_retrieved',
];

export function isGateFailure(outcome: ClaimOutcome): boolean {
  return GATE_FAILURE_VERDICTS.includes(outcome.verdict);
}

export function countVerdicts(outcomes: readonly ClaimOutcome[]): VerdictBreakdown {
  return {
    grounded: outcomes.filter((outcome) => outcome.verdict === 'grounded').length,
    not_grounded: outcomes.filter((outcome) => outcome.verdict === 'not_grounded').length,
    no_evidence_retrieved: outcomes.filter((outcome) => outcome.verdict === 'no_evidence_retrieved')
      .length,
    conflicting_evidence: outcomes.filter((outcome) => outcome.verdict === 'conflicting_evidence')
      .length,
  };
}

/** Rate over every drafted claim. An empty run is `0`, never a division by zero that would render
 *  as `NaN` in a report and read as a missing measurement rather than an empty one. */
export function gateFailureRate(breakdown: VerdictBreakdown): number {
  const total =
    breakdown.grounded +
    breakdown.not_grounded +
    breakdown.no_evidence_retrieved +
    breakdown.conflicting_evidence;
  if (total === 0) {
    return 0;
  }
  return (breakdown.not_grounded + breakdown.no_evidence_retrieved) / total;
}

export interface BarResult {
  readonly threshold: number;
  readonly observed: number;
  readonly met: boolean;
}

export function evaluateBar(observed: number, threshold: number): BarResult {
  return { threshold, observed, met: observed >= threshold };
}
