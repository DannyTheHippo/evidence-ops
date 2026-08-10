/**
 * Thrown by `CachingModelProvider` in replay mode on a cache miss. Replay must never fall
 * through to a live call — a future eval runner depends on replay runs being deterministic and
 * free, so a miss is a fixture-authoring bug that has to surface loudly, not a $0.03 surprise.
 */
export class ModelReplayCacheMissError extends Error {
  constructor(public readonly cacheKey: string) {
    super(
      `Replay cache miss for key '${cacheKey}' — no recorded fixture and replay mode never calls live`,
    );
    this.name = 'ModelReplayCacheMissError';
  }
}
