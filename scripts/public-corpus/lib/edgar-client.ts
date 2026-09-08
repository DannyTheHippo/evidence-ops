/**
 * Thin paced fetch client for SEC EDGAR. Two facts from SEC's fair-access policy
 * (https://www.sec.gov/os/accessing-edgar-data) are enforced here, not left to the caller:
 * a `User-Agent` naming the requester and a contact email is required at construction, and
 * requests are spaced no closer than {@link SEC_FAIR_ACCESS_MIN_INTERVAL_MS} apart regardless of
 * what `minIntervalMs` the caller passes — the cap cannot be exceeded by tightening the option.
 */

/** 10 requests/second, SEC's own ceiling; a caller-supplied `minIntervalMs` is never allowed below it. */
const SEC_FAIR_ACCESS_MIN_INTERVAL_MS = 100;

const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRIES = 5;

/** 429 (rate limit) and 503 (EDGAR under load) are transient; any other non-2xx is not retried. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Exponential backoff with full jitter — a uniform delay in `[0, min(base * 2^attempt, cap)]`. */
function computeBackoffMs(attempt: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.floor(Math.random() * cap);
}

/**
 * Real time by default; tests inject a virtual clock so request spacing and backoff run
 * instantly instead of sleeping in real time.
 */
export interface EdgarClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: EdgarClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class EdgarClient {
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  /** Epoch ms of the earliest time the next request may fire, reserved synchronously in `pace`. */
  private nextAllowedAt = 0;

  constructor(
    options: { userAgent: string; minIntervalMs: number; maxRetries?: number },
    private readonly clock: EdgarClock = REAL_CLOCK,
  ) {
    if (!options.userAgent.trim() || !options.userAgent.includes('@')) {
      throw new Error(
        'EdgarClient requires a User-Agent naming the requester and a contact email ' +
          `(SEC fair-access policy) — got: ${JSON.stringify(options.userAgent)}`,
      );
    }
    this.userAgent = options.userAgent;
    this.minIntervalMs = Math.max(options.minIntervalMs, SEC_FAIR_ACCESS_MIN_INTERVAL_MS);
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async fetchJson<T>(url: string): Promise<T> {
    const response = await this.request(url);
    return (await response.json()) as T;
  }

  async fetchBytes(url: string): Promise<Buffer> {
    const response = await this.request(url);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Reserves the next request slot synchronously, before any `await`, so two overlapping calls
   * on the same instance can't both read `nextAllowedAt` and burst together.
   */
  private async pace(): Promise<void> {
    const now = this.clock.now();
    const slot = Math.max(this.nextAllowedAt, now);
    this.nextAllowedAt = slot + this.minIntervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) {
      await this.clock.sleep(waitMs);
    }
  }

  private async request(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pace();

      let response: Response | undefined;
      try {
        response = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/json, text/html, application/pdf, */*',
          },
        });
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw new Error(
            `EDGAR request failed before a response was received: ${url} (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        }
        await this.clock.sleep(computeBackoffMs(attempt));
        continue;
      }

      if (response.ok) {
        return response;
      }

      if (!isRetryableStatus(response.status) || attempt >= this.maxRetries) {
        throw new Error(`EDGAR request failed: ${response.status} ${response.statusText} — ${url}`);
      }

      await this.clock.sleep(computeBackoffMs(attempt));
    }
  }
}
