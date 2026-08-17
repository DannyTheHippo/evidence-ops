/**
 * Not a `BaseException`/`HttpException` — the provider layer runs outside HTTP request scope
 * (Temporal activities, `scripts/`, and eventually an eval runner), so it cannot assume a
 * controller is there to catch it. Callers that do sit behind a controller are responsible for
 * mapping this to an HTTP response themselves.
 *
 * Thrown on a non-2xx response from the OpenAI-compatible chat/completions endpoint — either a
 * non-retryable 4xx surfaced immediately, or the final response body once the transport-retry
 * budget for 429/5xx/network failures is exhausted.
 */
export class OpenAiRequestFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`OpenAI chat completion request failed with status ${status}: ${body}`);
    this.name = 'OpenAiRequestFailedError';
  }
}
