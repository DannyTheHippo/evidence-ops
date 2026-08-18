import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod/v4';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { OpenAiInvalidResponseError } from './errors/openai-invalid-response.error';
import { OpenAiRequestFailedError } from './errors/openai-request-failed.error';
import { ModelBudgetExceededError } from './errors/model-budget-exceeded.error';
import { ModelSchemaValidationError } from './errors/model-schema-validation.error';
import { UnknownModelPricingError } from './errors/unknown-model-pricing.error';
import type {
  ModelMessage,
  ModelOutput,
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
  ModelUsage,
} from './model-provider.interface';
import {
  estimateTokenCount,
  formatIssuesForRetry,
  safeParseModelJson,
} from './model-output-validation.util';
import { computeOpenAiCostUsd, OPENAI_PRICING } from './openai-pricing.table';
import {
  toOpenAiStructuredOutputFormat,
  type OpenAiStructuredOutputFormat,
} from './to-openai-structured-output.util';

/** Fixed, not configurable — every OpenAI-compatible server (OpenAI itself, Azure OpenAI, vLLM,
 * Ollama) serves chat completions at this route relative to `config.openai.baseUrl`. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** Matches the Anthropic SDK's own default noted in `AnthropicModelProvider` (two transport
 * retries on top of the initial attempt), so the two providers stay symmetric under the same
 * failure class even though this provider has no SDK underneath it to do the retrying. */
const MAX_TRANSPORT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

interface OpenAiChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

const openAiUsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  // Optional: self-hosted vLLM/Ollama servers omit this block entirely — the keyless path this
  // provider exists to support.
  prompt_tokens_details: z.object({ cached_tokens: z.number() }).optional(),
});

const openAiChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        // Nullable defensively — `extractOutput` below coalesces a `null` content to `''` rather
        // than throw, since a self-hosted server's exact null-vs-absent behaviour is not pinned.
        message: z.object({
          content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: openAiUsageSchema,
});

type OpenAiChatCompletionResponse = z.infer<typeof openAiChatCompletionResponseSchema>;
type OpenAiUsage = z.infer<typeof openAiUsageSchema>;

/**
 * Real time by default; tests inject a virtual clock so the backoff sleeps between transport
 * retries run instantly instead of in real time.
 */
export interface OpenAiClock {
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: OpenAiClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function toOpenAiMessage(message: ModelMessage): OpenAiChatMessage {
  return { role: message.role, content: message.content };
}

function toOpenAiMessages(request: {
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
}): OpenAiChatMessage[] {
  const systemMessage: OpenAiChatMessage[] = request.system
    ? [{ role: 'system', content: request.system }]
    : [];
  return [...systemMessage, ...request.messages.map(toOpenAiMessage)];
}

function extractOutput(response: OpenAiChatCompletionResponse): string {
  return response.choices[0].message.content ?? '';
}

function toModelUsage(usage: OpenAiUsage): ModelUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function sumUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

function costUsdForUsage(model: string, usage: OpenAiUsage): number {
  return computeOpenAiCostUsd(model, {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  });
}

/** `toOpenAiStructuredOutputFormat` wraps a union-rooted schema under `{ result: … }` for
 * OpenAI's strict-mode root requirement — unwrap it here so callers never see the envelope. */
function unwrapIfWrapped(data: unknown, wrapped: boolean): unknown {
  return wrapped ? (data as { result: unknown }).result : data;
}

/** Exponential backoff with full jitter — same shape as `VoyageEmbeddingProvider`'s. */
function computeBackoffMs(attempt: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.floor(Math.random() * cap);
}

/** `Retry-After` (RFC 7231) may be delay-seconds or an HTTP-date; only delay-seconds is handled —
 * see `VoyageEmbeddingProvider`'s identical note for why. */
function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** 429 (rate limit) and 5xx (vendor's own fault) are transient; any other 4xx is a bad request
 * that fails identically on retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `OpenAI chat completion request timed out: ${error.message}`;
  }
  if (error instanceof Error) {
    return `OpenAI chat completion request failed before a response was received: ${error.message}`;
  }
  return 'OpenAI chat completion request failed before a response was received';
}

/**
 * `fetch`-based, not the vendor SDK — this project deliberately carries no `openai` dependency,
 * following `VoyageEmbeddingProvider`'s precedent. Targets any OpenAI-compatible
 * `/chat/completions` endpoint, so `config.openai.baseUrl` reaching a self-hosted vLLM/Ollama
 * server is a legitimate deployment, not an edge case.
 */
@Injectable()
export class OpenAiModelProvider implements ModelProvider {
  readonly info: ModelProviderInfo;

  constructor(
    private readonly config: TypedConfigService,
    // `@Optional()` because `OpenAiClock` is an interface — it erases to `Object` at runtime, so
    // Nest has no provider to resolve it against. Unresolvable + optional resolves to
    // `undefined`, which triggers this default just like a direct call would.
    @Optional() private readonly clock: OpenAiClock = REAL_CLOCK,
  ) {
    this.info = { provider: 'openai', model: this.config.openai.model };
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    this.assertBudget(request);

    // Widened to the base `z.ZodType` here for the same reason `AnthropicModelProvider` does:
    // TS can't carry the precise narrowing of a generic `TSchema` through a truthy check.
    const schema: z.ZodType | undefined = request.outputSchema;
    const responseFormat = schema
      ? toOpenAiStructuredOutputFormat(schema, request.taskClass)
      : undefined;
    const validationSchema: z.ZodType | undefined = !schema
      ? undefined
      : responseFormat?.wrapped
        ? z.object({ result: schema })
        : schema;

    // Built from named fields, never a spread of `request` — `passOrdinal`/`tenantId` (cache
    // partitioning and spend attribution only, see `ModelRequest`'s own doc comment) have no
    // vendor-API counterpart and must never reach the wire.
    const baseMessages = toOpenAiMessages(request);
    const first = await this.callChatCompletions(baseMessages, request.maxTokens, responseFormat);

    if (!schema || !validationSchema) {
      return {
        output: extractOutput(first) as ModelOutput<TSchema>,
        usage: toModelUsage(first.usage),
        costUsd: costUsdForUsage(this.info.model, first.usage),
      };
    }

    const firstText = extractOutput(first);
    const firstParsed = safeParseModelJson(firstText, validationSchema);
    if (firstParsed.success) {
      return {
        output: unwrapIfWrapped(
          firstParsed.data,
          responseFormat?.wrapped ?? false,
        ) as ModelOutput<TSchema>,
        usage: toModelUsage(first.usage),
        costUsd: costUsdForUsage(this.info.model, first.usage),
      };
    }

    // Exactly one retry, feeding the validation errors back to the model — matches
    // `AnthropicModelProvider`'s retry count for the same failure class. Usage/cost from both
    // calls accumulate — the retry is a real billed request.
    const retryMessages: OpenAiChatMessage[] = [
      ...baseMessages,
      { role: 'assistant', content: firstText },
      {
        role: 'user',
        content: `Your previous response failed schema validation:\n${formatIssuesForRetry(firstParsed.issues)}\n\nReturn ONLY corrected JSON matching the schema.`,
      },
    ];

    const retry = await this.callChatCompletions(retryMessages, request.maxTokens, responseFormat);
    const retryText = extractOutput(retry);
    const retryParsed = safeParseModelJson(retryText, validationSchema);
    const usage = sumUsage(toModelUsage(first.usage), toModelUsage(retry.usage));
    const costUsd =
      costUsdForUsage(this.info.model, first.usage) + costUsdForUsage(this.info.model, retry.usage);

    if (retryParsed.success) {
      return {
        output: unwrapIfWrapped(
          retryParsed.data,
          responseFormat?.wrapped ?? false,
        ) as ModelOutput<TSchema>,
        usage,
        costUsd,
      };
    }

    throw new ModelSchemaValidationError(retryParsed.issues, retryText);
  }

  /**
   * Fails CLOSED: refuses the call outright rather than silently truncating `maxTokens` down to
   * fit the budget. The estimate is worst-case (full `maxTokens` output, prompt-length input
   * estimate) — it can only over-refuse, never under-refuse.
   */
  private assertBudget(request: {
    readonly system?: string;
    readonly messages: readonly ModelMessage[];
    readonly maxTokens: number;
    readonly maxCostUsd: number;
  }): void {
    const pricing = OPENAI_PRICING[this.info.model];
    if (!pricing) {
      throw new UnknownModelPricingError(this.info.model, 'OpenAI', 'openai-pricing.table.ts');
    }

    const promptText = (request.system ?? '') + request.messages.map((m) => m.content).join('');
    const estimatedInputTokens = estimateTokenCount(promptText);
    const estimatedCostUsd =
      (estimatedInputTokens * pricing.input + request.maxTokens * pricing.output) / 1_000_000;

    if (estimatedCostUsd > request.maxCostUsd) {
      throw new ModelBudgetExceededError(estimatedCostUsd, request.maxCostUsd);
    }
  }

  /**
   * Retries 429/5xx responses and network/timeout failures — a `Retry-After` header on a 429
   * takes priority over the computed backoff when present. Any other non-2xx status (a bad
   * request or bad key) throws immediately: it will never succeed on retry.
   */
  private async callChatCompletions(
    messages: readonly OpenAiChatMessage[],
    maxCompletionTokens: number,
    responseFormat: OpenAiStructuredOutputFormat | undefined,
  ): Promise<OpenAiChatCompletionResponse> {
    const { apiKey, baseUrl, timeoutMs } = this.config.openai;
    const url = `${baseUrl}${CHAT_COMPLETIONS_PATH}`;
    const body = JSON.stringify({
      model: this.info.model,
      messages,
      max_completion_tokens: maxCompletionTokens,
      response_format: responseFormat
        ? { type: responseFormat.type, json_schema: responseFormat.json_schema }
        : undefined,
    });

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
        failureMessage = describeFetchFailure(error);
      }

      if (response?.ok) {
        const parsed = openAiChatCompletionResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new OpenAiInvalidResponseError(
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          );
        }
        return parsed.data;
      }

      const responseText = response
        ? await response.text()
        : (failureMessage ??
          'OpenAI chat completion request failed before a response was received');

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
