import { createHash } from 'node:crypto';

/**
 * Sorts before hashing so the fingerprint is order-independent: `evidence_chunks._id` is
 * content-addressed (`computeChunkId`) but Mongo returns rows in whatever order the query planner
 * picks, not insertion order, so an unsorted hash would flap between identical runs and make a
 * genuine corpus change indistinguishable from query-order noise.
 */
export function computeCorpusFingerprint(chunkIds: readonly string[]): string {
  const sorted = [...chunkIds].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}
