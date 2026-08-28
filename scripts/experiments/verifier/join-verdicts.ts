import type { VerifyClaimResult } from '../../../src/features/evidence/qa/contracts/verify-claims.contract';
import type { ClaimOutcome, DraftedClaim } from './types';

/**
 * Joins one batch's `VerifyClaimResult` rows back onto the claims that batch submitted.
 * `claimIndex` is an index into the batch, not into the run, so this is where a batch-local index
 * becomes a run-wide `claimId`.
 *
 * Fails CLOSED on every join anomaly — a missing, duplicated, or out-of-range `claimIndex`, or a
 * result count that does not match the batch. This is a measurement harness: a verdict silently
 * attached to the wrong claim would corrupt both the rate and the hand adjudication that reads the
 * claim text next to it, and neither would look wrong.
 */
export function joinVerdicts(
  batch: readonly DraftedClaim[],
  results: readonly VerifyClaimResult[],
): readonly ClaimOutcome[] {
  if (results.length !== batch.length) {
    throw new Error(
      `joinVerdicts: expected ${batch.length} result(s) for this batch, got ${results.length}`,
    );
  }

  const resultByIndex = new Map<number, VerifyClaimResult>();
  for (const result of results) {
    if (result.claimIndex < 0 || result.claimIndex >= batch.length) {
      throw new Error(
        `joinVerdicts: claimIndex ${result.claimIndex} is outside the ${batch.length}-claim batch`,
      );
    }
    if (resultByIndex.has(result.claimIndex)) {
      throw new Error(`joinVerdicts: duplicate result for claimIndex ${result.claimIndex}`);
    }
    resultByIndex.set(result.claimIndex, result);
  }

  return batch.map((claim, index) => {
    const result = resultByIndex.get(index);
    if (!result) {
      throw new Error(`joinVerdicts: no result for claimIndex ${index} (claim ${claim.claimId})`);
    }
    return {
      ...claim,
      verdict: result.verdict,
      reasonCode: result.reasonCode,
      citations: result.citations,
    };
  });
}
