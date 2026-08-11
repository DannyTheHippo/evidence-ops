/**
 * Thrown when Voyage keeps returning 429 past either the retry-attempt cap or the total-wait
 * budget for a single batch. This is the throughput limiter's failure direction, not a safety
 * gate: it fails CLOSED once the retry budget is spent, surfacing a clear terminal error instead
 * of retrying forever — an unbounded wait inside a Temporal activity is worse than a clean
 * failure the caller can see and re-run later.
 */
export class VoyageRateLimitExceededError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly waitedMs: number,
    public readonly lastResponseBody: string,
  ) {
    super(
      `Voyage embeddings request still rate-limited after ${attempts} retr${attempts === 1 ? 'y' : 'ies'} and ${waitedMs}ms of backoff: ${lastResponseBody}`,
    );
    this.name = 'VoyageRateLimitExceededError';
  }
}
