import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod/v4';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import {
  computeBackoffMs,
  describeFetchFailure,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../http-retry.util';
import { OpenAiInvalidResponseError } from '../model/errors/openai-invalid-response.error';
import { OpenAiRequestFailedError } from '../model/errors/openai-request-failed.error';
import { REAL_CLOCK, type OpenAiClock } from '../model/openai-chat-completions.client';
import type {
  EmbeddingProvider,
  EmbeddingProviderInfo,
  EmbeddingRequest,
  EmbeddingResult,
} from './embedding-provider.interface';

const EMBEDDINGS_PATH = '/embeddings';
/** OpenAI's own vendor limit; every OpenAI-compatible server (vLLM, Ollama) is assumed to accept
 * at least this many inputs per request. */
const MAX_INPUTS_PER_REQUEST = 2_048;
/** Matches `openai-chat-completions.client.ts`'s transport-retry count, so both providers built on
 * this client family stay symmetric under the same failure class. */
const MAX_TRANSPORT_RETRIES = 2;

const openAiEmbeddingsResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  usage: z.object({ total_tokens: z.number() }),
});

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Targets any OpenAI-compatible `/embeddings` endpoint under the `OPENAI_COMPATIBLE_*` namespace.
 * The request body carries only `{ model, input }`: no `dimensions` (native output width is the
 * common self-hosted case; Matryoshka truncation stays Voyage-specific — `EMBEDDING_DIMENSIONS`
 * is instead enforced on the response, below) and no `input_type` (OpenAI's embeddings API has no
 * document/query distinction, unlike Voyage's).
 */
@Injectable()
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(
    private readonly config: TypedConfigService,
    // `@Optional()` because `OpenAiClock` is an interface — it erases to `Object` at runtime, so
    // Nest has no provider to resolve it against. Unresolvable + optional resolves to
    // `undefined`, which triggers this default just like a direct call would.
    @Optional() private readonly clock: OpenAiClock = REAL_CLOCK,
  ) {
    this.info = {
      provider: 'openai-compatible',
      model: this.config.openaiCompatible.embeddingModel,
      dimensions: this.config.embedding.dimensions,
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.inputs.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0 } };
    }

    // Sequential, not `Promise.all` — matches `VoyageEmbeddingProvider`'s batching; nothing here
    // paces requests, so there is no shared state a concurrent batch could race.
    const batches = chunk(request.inputs, MAX_INPUTS_PER_REQUEST);
    const results: EmbeddingResult[] = [];
    for (const batch of batches) {
      results.push(await this.embedBatch(batch));
    }

    return {
      embeddings: results.flatMap((result) => result.embeddings),
      usage: { totalTokens: results.reduce((sum, result) => sum + result.usage.totalTokens, 0) },
    };
  }

  private async embedBatch(inputs: readonly string[]): Promise<EmbeddingResult> {
    const { apiKey, baseUrl, timeoutMs } = this.config.openaiCompatible;
    const url = `${baseUrl}${EMBEDDINGS_PATH}`;
    const body = JSON.stringify({ model: this.info.model, input: inputs });

    // Omitted entirely when no key is configured, not sent as `Bearer undefined` — this is what
    // makes a keyless self-hosted vLLM/Ollama endpoint reachable.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      let failureMessage: string | undefined;

      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // No response at all — a hung connection past the timeout, or a network failure. Both
        // fall through to the retry path below exactly like a 5xx.
        failureMessage = describeFetchFailure('OpenAI-compatible embedding', error);
      }

      if (response?.ok) {
        const parsed = openAiEmbeddingsResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new OpenAiInvalidResponseError(
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          );
        }

        const sorted = [...parsed.data.data].sort((a, b) => a.index - b.index);
        // Fails CLOSED: a vector whose width the server returned does not match the configured
        // vector-index width must never reach the index — a wrong-width vector inserted there
        // would corrupt every subsequent `$vectorSearch` over that field.
        const mismatched = sorted.find((entry) => entry.embedding.length !== this.info.dimensions);
        if (mismatched) {
          throw new OpenAiInvalidResponseError([
            {
              path: `data.${mismatched.index}.embedding`,
              message: `expected ${this.info.dimensions} dimensions, received ${mismatched.embedding.length}`,
            },
          ]);
        }

        return {
          embeddings: sorted.map((entry) => entry.embedding),
          usage: { totalTokens: parsed.data.usage.total_tokens },
        };
      }

      const responseText = response
        ? await response.text()
        : (failureMessage ??
          'OpenAI-compatible embedding request failed before a response was received');

      // A bad key or a malformed request (401/400/...) will never succeed on retry. 429 (rate
      // limit), 5xx (vendor's own fault), and a failure before any response arrived (timeout or
      // network error, `response` undefined here) are all transient and worth another attempt.
      if (response && !isRetryableStatus(response.status)) {
        throw new OpenAiRequestFailedError(response.status, responseText);
      }

      if (attempt >= MAX_TRANSPORT_RETRIES) {
        throw new OpenAiRequestFailedError(response?.status ?? 0, responseText);
      }

      const delayMs = response
        ? (parseRetryAfterMs(response.headers.get('retry-after')) ?? computeBackoffMs(attempt))
        : computeBackoffMs(attempt);
      await this.clock.sleep(delayMs);
    }
  }
}
