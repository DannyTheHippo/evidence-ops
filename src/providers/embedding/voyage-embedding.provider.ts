import { Injectable, Optional } from '@nestjs/common';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { VoyageApiKeyMissingError } from './errors/voyage-api-key-missing.error';
import { VoyageRateLimitExceededError } from './errors/voyage-rate-limit-exceeded.error';
import { VoyageRequestFailedError } from './errors/voyage-request-failed.error';
import type {
  EmbeddingInputType,
  EmbeddingProvider,
  EmbeddingProviderInfo,
  EmbeddingRequest,
  EmbeddingResult,
} from './embedding-provider.interface';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
/** Vendor limit: at most 1000 inputs per request. */
const MAX_INPUTS_PER_REQUEST = 1000;
/** Exponential-backoff shape for a 429 with no `Retry-After` header. */
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

interface VoyageEmbeddingsResponse {
  readonly data: { readonly embedding: number[]; readonly index: number }[];
  readonly usage: { readonly total_tokens: number };
}

/**
 * Real time by default; tests inject a virtual clock so a 3-requests-per-minute pace (20s between
 * calls) and multi-second backoffs run instantly instead of sleeping in real time.
 */
export interface VoyageClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: VoyageClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Exponential backoff with full jitter (AWS's formula): a uniform random delay in
 * `[0, min(base * 2^attempt, cap)]` avoids every rate-limited caller retrying in lockstep.
 */
function computeBackoffMs(attempt: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.floor(Math.random() * cap);
}

/**
 * `Retry-After` (RFC 7231) may be delay-seconds or an HTTP-date. Only delay-seconds is handled
 * here — it's the form every REST API sends in practice; an HTTP-date falls through to the
 * computed backoff instead of guessing at a date-parse edge case nothing has sent yet.
 */
function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Thin typed fetch client, not the vendor SDK — Voyage's embeddings API is a single endpoint,
 * and retry/telemetry behaviour belongs in decorators at this layer, not in a vendor library.
 */
@Injectable()
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  /** Epoch ms of the earliest time the next request may fire; reserved synchronously in `pace`. */
  private nextAllowedAt = 0;

  constructor(
    private readonly config: TypedConfigService,
    // `@Optional()` because `VoyageClock` is an interface — it erases to `Object` at runtime, so
    // Nest has no provider to resolve it against. Unresolvable + optional resolves to `undefined`,
    // which triggers this default just like a direct call would.
    @Optional() private readonly clock: VoyageClock = REAL_CLOCK,
  ) {
    this.info = {
      provider: 'voyage',
      model: this.config.voyage.model,
      dimensions: this.config.voyage.dimensions,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.inputs.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0 } };
    }

    // Sequential, not `Promise.all`: pacing reserves one shared `nextAllowedAt` slot per request,
    // and concurrent batches would race that read-modify-write. Fine at 3 RPM — see `pace`.
    const batches = chunk(request.inputs, MAX_INPUTS_PER_REQUEST);
    const results: EmbeddingResult[] = [];
    for (const batch of batches) {
      results.push(await this.embedBatch(batch, request.inputType));
    }

    return {
      embeddings: results.flatMap((result) => result.embeddings),
      usage: { totalTokens: results.reduce((sum, result) => sum + result.usage.totalTokens, 0) },
    };
  }

  private async embedBatch(
    inputs: readonly string[],
    inputType: EmbeddingInputType,
  ): Promise<EmbeddingResult> {
    const apiKey = this.config.voyage.apiKey;
    if (!apiKey) {
      throw new VoyageApiKeyMissingError();
    }

    const { maxRetries, maxRetryWaitMs } = this.config.voyage;
    const body = JSON.stringify({
      input: inputs,
      model: this.info.model,
      input_type: inputType,
      output_dimension: this.info.dimensions,
      truncation: true,
    });

    let waitedMs = 0;

    for (let attempt = 0; ; attempt++) {
      await this.pace();

      const response = await fetch(VOYAGE_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
      });

      if (response.ok) {
        const responseBody = (await response.json()) as VoyageEmbeddingsResponse;
        const embeddings = [...responseBody.data]
          .sort((a, b) => a.index - b.index)
          .map((entry) => entry.embedding);

        return { embeddings, usage: { totalTokens: responseBody.usage.total_tokens } };
      }

      const responseText = await response.text();

      // A bad key or a malformed request (401/400/...) will never succeed on retry — only a 429
      // is transient. Retrying anything else just burns the attempt/wait budget on a permanent
      // failure.
      if (response.status !== 429) {
        throw new VoyageRequestFailedError(response.status, responseText);
      }

      // Throughput limiter, not a safety gate: once the retry-attempt cap or total-wait budget is
      // spent, this fails CLOSED with a clear terminal error rather than retrying forever.
      if (attempt >= maxRetries) {
        throw new VoyageRateLimitExceededError(attempt, waitedMs, responseText);
      }

      const delayMs =
        parseRetryAfterMs(response.headers.get('retry-after')) ?? computeBackoffMs(attempt);
      if (waitedMs + delayMs > maxRetryWaitMs) {
        throw new VoyageRateLimitExceededError(attempt, waitedMs, responseText);
      }

      await this.clock.sleep(delayMs);
      waitedMs += delayMs;
    }
  }

  /**
   * Sequential pacing, not a token bucket — at 3 RPM, spacing every request `60000 / rpm`ms apart
   * is enough; a token bucket only earns its complexity under bursty concurrent traffic, which a
   * single provider instance never generates (`embed` itself is sequential; see there).
   *
   * The slot is reserved synchronously, before the `await`, so two overlapping `embedBatch` calls
   * on the same instance can't both read the same `nextAllowedAt` and burst together.
   */
  private async pace(): Promise<void> {
    const rpm = this.config.voyage.requestsPerMinute;
    if (rpm <= 0) {
      return;
    }

    const intervalMs = 60_000 / rpm;
    const now = this.clock.now();
    const slot = Math.max(this.nextAllowedAt, now);
    this.nextAllowedAt = slot + intervalMs;

    const waitMs = slot - now;
    if (waitMs > 0) {
      await this.clock.sleep(waitMs);
    }
  }
}
