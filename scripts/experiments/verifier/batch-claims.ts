import type { DraftedClaim } from './types';

/**
 * Splits drafted claims into submission batches of at most `maxBatchSize`, preserving order. The
 * bound is passed in rather than read from `VERIFY_CLAIMS_MAX_CLAIMS` here so this module stays
 * free of the MCP tool graph; the caller supplies the tool's own constant.
 *
 * Throws on a non-positive bound: a zero or negative size would otherwise loop forever or emit
 * empty batches, and a batch of zero claims is a call `verifyClaims` would reject anyway.
 */
export function batchClaims(
  claims: readonly DraftedClaim[],
  maxBatchSize: number,
): readonly (readonly DraftedClaim[])[] {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
    throw new Error(`batchClaims: maxBatchSize must be a positive integer, got ${maxBatchSize}`);
  }

  const batches: DraftedClaim[][] = [];
  for (let index = 0; index < claims.length; index += maxBatchSize) {
    batches.push([...claims.slice(index, index + maxBatchSize)]);
  }
  return batches;
}
