/**
 * Mirrors `src/providers/model/errors/model-replay-cache-miss.error.ts`. Thrown by
 * `CachingEmbeddingProvider` in replay mode on a cache miss: replay must never fall through to a
 * live Voyage call, the same invariant the model-side cache enforces, for the same reason — a
 * missing fixture here is an eval-authoring bug (a new question or a new fixture file that was
 * never recorded), not something to paper over with a live network call in a supposedly free,
 * deterministic CI run.
 */
export class EmbeddingReplayCacheMissError extends Error {
  constructor(public readonly cacheKey: string) {
    super(
      `Replay cache miss for key '${cacheKey}' — no recorded embedding fixture and replay mode never calls live`,
    );
    this.name = 'EmbeddingReplayCacheMissError';
  }
}
