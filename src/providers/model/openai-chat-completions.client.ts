import { toJSONSchema, z } from 'zod/v4';
import {
  computeBackoffMs,
  describeFetchFailure,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../http-retry.util';
import { ModelOutputTruncatedError } from './errors/model-output-truncated.error';
import { ModelSchemaValidationError } from './errors/model-schema-validation.error';
import { OpenAiInvalidResponseError } from './errors/openai-invalid-response.error';
import { OpenAiRequestFailedError } from './errors/openai-request-failed.error';
import type {
  ModelMessage,
  ModelOutput,
  ModelRequest,
  ModelResult,
  ModelUsage,
} from './model-provider.interface';
import { formatIssuesForRetry, safeParseModelJson } from './model-output-validation.util';
import {
  toOpenAiStructuredOutputFormat,
  withoutSchemaKeyword,
  type OpenAiStructuredOutputFormat,
} from './to-openai-structured-output.util';

/** Fixed, not configurable — every OpenAI-compatible server (OpenAI itself, Azure OpenAI, vLLM,
 * Ollama) serves chat completions at this route relative to the target's `baseUrl`. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** Matches the Anthropic SDK's own default noted in `AnthropicModelProvider` (two transport
 * retries on top of the initial attempt), so every provider built on this client stays symmetric
 * under the same failure class even though none of them has an SDK underneath doing the retrying. */
const MAX_TRANSPORT_RETRIES = 2;

interface OpenAiChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

const openAiUsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  // Optional: self-hosted vLLM/Ollama servers omit this block entirely — the keyless path this
  // client exists to support.
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
        // Nullable and optional for the same self-hosted-server reason `content` above is: a
        // vLLM/Ollama endpoint's exact null-vs-absent behaviour for this field is not pinned
        // either. Both a `null` and an absent value mean there is no cap signal to check, so
        // `extractFinishReason` treats them identically — the response is not length-truncated.
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: openAiUsageSchema,
});

type OpenAiChatCompletionResponse = z.infer<typeof openAiChatCompletionResponseSchema>;
export type OpenAiUsage = z.infer<typeof openAiUsageSchema>;

/**
 * Real time by default; tests inject a virtual clock so the backoff sleeps between transport
 * retries run instantly instead of in real time.
 */
export interface OpenAiClock {
  sleep(ms: number): Promise<void>;
}

export const REAL_CLOCK: OpenAiClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The connection details a `/chat/completions` call needs, factored out of `TypedConfigService`
 * so this client serves both the `openai` and `openaiCompatible` namespaces without either
 * provider reaching into the other's config. */
export interface ChatCompletionsTarget {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly model: string;
  readonly clock: OpenAiClock;
}

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

function extractFinishReason(response: OpenAiChatCompletionResponse): string | null | undefined {
  return response.choices[0].finish_reason;
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

/** `toOpenAiStructuredOutputFormat` wraps a union-rooted schema under `{ result: … }` for
 * OpenAI's strict-mode root requirement — unwrap it here so callers never see the envelope.
 * `prompt` mode never builds a wrapped format (see `buildPromptModeSystem`), so this is a no-op
 * for that mode. */
function unwrapIfWrapped(data: unknown, wrapped: boolean): unknown {
  return wrapped ? (data as { result: unknown }).result : data;
}

/** `mode === 'prompt'` sends no `response_format` at all; instead the schema is spelled out at the
 * end of the system message and the model's raw JSON is validated on return, unwrapped — the
 * `{ result: … }` envelope exists only to satisfy OpenAI's strict-mode root requirement, which
 * `prompt` mode never invokes. */
function buildPromptModeSystem(system: string | undefined, schema: z.ZodType): string {
  const schemaText = JSON.stringify(
    withoutSchemaKeyword(toJSONSchema(schema, { reused: 'inline' })),
  );
  return `${system ?? ''}\n\nRespond with a single JSON value matching this JSON Schema and nothing else:\n${schemaText}`;
}

/**
 * Retries 429/5xx responses and network/timeout failures — a `Retry-After` header on a 429 takes
 * priority over the computed backoff when present. Any other non-2xx status (a bad request or bad
 * key) throws immediately: it will never succeed on retry.
 */
export async function callChatCompletions(
  target: ChatCompletionsTarget,
  messages: readonly OpenAiChatMessage[],
  maxCompletionTokens: number,
  responseFormat: OpenAiStructuredOutputFormat | undefined,
): Promise<OpenAiChatCompletionResponse> {
  const url = `${target.baseUrl}${CHAT_COMPLETIONS_PATH}`;
  const body = JSON.stringify({
    model: target.model,
    messages,
    max_completion_tokens: maxCompletionTokens,
    response_format: responseFormat
      ? { type: responseFormat.type, json_schema: responseFormat.json_schema }
      : undefined,
  });

  // Omitted entirely when no key is configured, not sent as `Bearer undefined` — this is what
  // makes a keyless self-hosted vLLM/Ollama endpoint reachable.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.apiKey) {
    headers.Authorization = `Bearer ${target.apiKey}`;
  }

  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    let failureMessage: string | undefined;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (error) {
      // No response at all — a hung connection past the timeout, or a network failure. Both
      // fall through to the retry path below exactly like a 5xx.
      failureMessage = describeFetchFailure('OpenAI chat completion', error);
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
      : (failureMessage ?? 'OpenAI chat completion request failed before a response was received');

    if (response && !isRetryableStatus(response.status)) {
      throw new OpenAiRequestFailedError(response.status, responseText);
    }

    if (attempt >= MAX_TRANSPORT_RETRIES) {
      throw new OpenAiRequestFailedError(response?.status ?? 0, responseText);
    }

    const delayMs = response
      ? (parseRetryAfterMs(response.headers.get('retry-after')) ?? computeBackoffMs(attempt))
      : computeBackoffMs(attempt);
    await target.clock.sleep(delayMs);
  }
}

/**
 * The shared generate loop behind `OpenAiModelProvider` and `OpenAiCompatibleModelProvider`: one
 * call, a JSON parse/validate against `request.outputSchema`, an output-cap check, and — on a
 * validation failure that is not itself a truncation — exactly one correction turn before giving
 * up. `costUsd` is a callback rather than a table lookup because the two providers price
 * differently: `OpenAiModelProvider` prices from `OPENAI_PRICING`, `OpenAiCompatibleModelProvider`
 * from its own configured per-token rates.
 */
export async function generateWithSchemaRetry<TSchema extends z.ZodType | undefined = undefined>(
  target: ChatCompletionsTarget,
  request: ModelRequest<TSchema>,
  mode: 'json_schema' | 'prompt',
  costUsd: (usage: OpenAiUsage) => number,
): Promise<ModelResult<TSchema>> {
  // Widened to the base `z.ZodType` here for the same reason `AnthropicModelProvider` does: TS
  // can't carry the precise narrowing of a generic `TSchema` through a truthy check.
  const schema: z.ZodType | undefined = request.outputSchema;
  const responseFormat =
    schema && mode === 'json_schema'
      ? toOpenAiStructuredOutputFormat(schema, request.taskClass)
      : undefined;
  const validationSchema: z.ZodType | undefined = !schema
    ? undefined
    : responseFormat?.wrapped
      ? z.object({ result: schema })
      : schema;
  const effectiveSystem =
    schema && mode === 'prompt' ? buildPromptModeSystem(request.system, schema) : request.system;

  // Built from named fields, never a spread of `request` — `passOrdinal`/`tenantId` (cache
  // partitioning and spend attribution only, see `ModelRequest`'s own doc comment) have no
  // vendor-API counterpart and must never reach the wire.
  const baseMessages = toOpenAiMessages({ system: effectiveSystem, messages: request.messages });
  const first = await callChatCompletions(target, baseMessages, request.maxTokens, responseFormat);

  if (!schema || !validationSchema) {
    // A truncated free-text answer is the caller's business, not a hard failure here — with no
    // outputSchema there is no downstream parse a truncation would break, so the text comes back
    // as-is regardless of finish_reason.
    return {
      output: extractOutput(first) as ModelOutput<TSchema>,
      usage: toModelUsage(first.usage),
      costUsd: costUsd(first.usage),
    };
  }

  const firstText = extractOutput(first);
  const firstParsed = safeParseModelJson(firstText, validationSchema);
  if (firstParsed.success) {
    // A response is valid regardless of why generation stopped — a `finish_reason` that would
    // otherwise mean truncation is moot once the emitted text has already parsed and validated.
    return {
      output: unwrapIfWrapped(
        firstParsed.data,
        responseFormat?.wrapped ?? false,
      ) as ModelOutput<TSchema>,
      usage: toModelUsage(first.usage),
      costUsd: costUsd(first.usage),
    };
  }

  // Consulted only once the parse/validation above has already failed: the cap signal explains
  // *why* an unparseable response is unparseable, it does not by itself mean the response is bad.
  // A response cut off by the output cap is incomplete by construction, so entering the
  // schema-validation retry below would resend the same (or a longer) prompt against the same cap
  // and reproduce the same cutoff — that retry is a real billed request.
  if (extractFinishReason(first) === 'length') {
    throw new ModelOutputTruncatedError(
      'length',
      request.maxTokens,
      first.usage.completion_tokens,
      firstText,
    );
  }

  // Exactly one retry, feeding the validation errors back to the model — matches
  // `AnthropicModelProvider`'s retry count for the same failure class. Usage/cost from both calls
  // accumulate — the retry is a real billed request.
  const correctionMessage: OpenAiChatMessage = {
    role: 'user',
    content: `Your previous response failed schema validation:\n${formatIssuesForRetry(firstParsed.issues)}\n\nReturn ONLY corrected JSON matching the schema.`,
  };
  // Some providers reject an empty assistant content turn outright, matching
  // `AnthropicModelProvider`'s handling: when the model produced no visible (non-whitespace)
  // text, there is nothing to echo back, so the correction turn is appended directly instead.
  const retryMessages: OpenAiChatMessage[] = firstText.trim()
    ? [...baseMessages, { role: 'assistant', content: firstText }, correctionMessage]
    : [...baseMessages, correctionMessage];

  const retry = await callChatCompletions(target, retryMessages, request.maxTokens, responseFormat);
  const retryText = extractOutput(retry);
  const retryParsed = safeParseModelJson(retryText, validationSchema);
  const usage = sumUsage(toModelUsage(first.usage), toModelUsage(retry.usage));
  const totalCostUsd = costUsd(first.usage) + costUsd(retry.usage);

  if (retryParsed.success) {
    return {
      output: unwrapIfWrapped(
        retryParsed.data,
        responseFormat?.wrapped ?? false,
      ) as ModelOutput<TSchema>,
      usage,
      costUsd: totalCostUsd,
    };
  }

  if (extractFinishReason(retry) === 'length') {
    throw new ModelOutputTruncatedError(
      'length',
      request.maxTokens,
      retry.usage.completion_tokens,
      retryText,
    );
  }

  throw new ModelSchemaValidationError(retryParsed.issues, retryText);
}
