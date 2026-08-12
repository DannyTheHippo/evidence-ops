const CHUNK_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Qdrant point ids must be an unsigned 64-bit integer or a UUID — this project's `EvidenceChunk
 * ._id` (`compute-chunk-id.ts`) is a 64-char sha256 hex digest, which is neither. Rather than
 * hashing again (which would need to be reversible to recover `chunkId` from a hit) this just
 * reformats the digest's first 32 hex characters into UUID 8-4-4-4-12 grouping — deterministic and
 * collision-safe for the same reason the sha256 digest itself is, and the real `chunkId` still
 * travels in the point payload (`chunk-to-point.util.ts`) so nothing here needs to be reversed.
 *
 * Fails CLOSED on anything that is not exactly 64 lowercase hex characters: a malformed id
 * formatted anyway would still produce *a* UUID-shaped string, silently corrupting the benchmark
 * instead of raising anywhere.
 */
export function chunkIdToPointId(chunkId: string): string {
  if (!CHUNK_ID_PATTERN.test(chunkId)) {
    throw new Error(
      `chunkIdToPointId requires a 64-char lowercase hex sha256 digest, got: ${chunkId}`,
    );
  }
  const uuidSource = chunkId.slice(0, 32);
  return [
    uuidSource.slice(0, 8),
    uuidSource.slice(8, 12),
    uuidSource.slice(12, 16),
    uuidSource.slice(16, 20),
    uuidSource.slice(20, 32),
  ].join('-');
}
