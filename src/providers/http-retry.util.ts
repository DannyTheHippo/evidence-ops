const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

/** Exponential backoff with full jitter — shared shape for every `fetch`-based provider that
 * carries no vendor SDK to do its own retrying. */
export function computeBackoffMs(attempt: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.floor(Math.random() * cap);
}

/** `Retry-After` (RFC 7231) may be delay-seconds or an HTTP-date; only delay-seconds is handled —
 * an HTTP-date value falls through to the computed backoff instead. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** 429 (rate limit) and 5xx (vendor's own fault) are transient; any other 4xx is a bad request
 * that fails identically on retry. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `label` names the call in the resulting message (e.g. "OpenAI chat completion",
 * "OpenAI-compatible embedding") so one function serves every caller instead of each hardcoding
 * its own copy of this text. */
export function describeFetchFailure(label: string, error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${label} request timed out: ${error.message}`;
  }
  if (error instanceof Error) {
    return `${label} request failed before a response was received: ${error.message}`;
  }
  return `${label} request failed before a response was received`;
}
