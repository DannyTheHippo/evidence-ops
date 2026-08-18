import { chunkOverlapsAnyLocator, type OverlapCandidateChunk } from './locator-overlap';
import type { Locator } from '../dataset/schema';

/**
 * Whether a `conflicting_evidence` outcome's conflict is scoped to the case's own fact, not merely
 * "some conflict was surfaced". A `conflicting` case's `expectedLocators` names the documents the
 * seeded conflict actually lives in; without this check a case passed the moment the harness saw
 * any `conflicting_evidence` outcome, including one attached to an unrelated property's fact.
 *
 * True only when every `values[].sourceChunkId` resolves to a chunk that overlaps at least one of
 * `expectedLocators` (`chunkOverlapsAnyLocator`, the same overlap predicate `eval/run.ts` already
 * uses for retrieval/citation scoring) — a `sourceChunkId` that fails to resolve at all (never
 * happens for a server-built outcome, but `resolveChunk` can return `undefined`) counts as not
 * overlapping rather than throwing, so one malformed value fails the check instead of aborting the
 * case's scoring. An outcome with no values at all (never produced — `conflictingEvidenceOutcomeSchema`
 * requires at least two) is treated as failing rather than vacuously passing.
 */
export async function conflictValuesOverlapExpectedLocators(
  sourceChunkIds: readonly string[],
  resolveChunk: (chunkId: string) => OverlapCandidateChunk | undefined,
  expectedLocators: readonly Locator[],
): Promise<boolean> {
  if (sourceChunkIds.length === 0) {
    return false;
  }
  const overlaps = await Promise.all(
    sourceChunkIds.map(async (chunkId) => {
      const chunk = resolveChunk(chunkId);
      if (!chunk) {
        return false;
      }
      return chunkOverlapsAnyLocator(chunk, expectedLocators);
    }),
  );
  return overlaps.every(Boolean);
}
