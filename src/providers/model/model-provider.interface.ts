import type { z } from 'zod/v4';

/**
 * Deliberate convention exception: `.claude/CLAUDE.md` says "zod is env-only; requests use
 * class-validator". That rule targets HTTP DTOs. The provider layer uses zod as the schema
 * language for model input/output because the schema must convert to JSON Schema for
 * Anthropic's `output_format` and stay reusable by the eval dataset in `eval/` once a runner
 * exists to score against it. Scoped to `src/providers/**` and model contracts only.
 *
 * `zod/v4` specifically (not the bare `zod` import, which resolves to v3 in this package's
 * transitional 3.25.x release) — `structured-output-format.util.ts`'s `toJSONSchema()` call and
 * `cache-key.util.ts` both require a v4 `ZodType`, and v3/v4 schema instances are not
 * interchangeable at runtime.
 */
export type TaskClass = 'qa_answer' | 'fact_extraction';

/**
 * A tool exposed to the model for one `generate` call. `inputSchema` is a zod schema — not JSON
 * Schema directly — for the same reason `ModelRequest.outputSchema` is: it stays the single
 * source of truth both vendor providers convert from via `toJSONSchema`
 * (`structured-output-format.util.ts` already does this conversion for `outputSchema`).
 *
 * Vendor mapping: Anthropic takes `{name, description, input_schema}` per entry in its `tools`
 * request field. OpenAI takes `{type: 'function', function: {name, description, parameters}}`
 * per entry in its own `tools` field. Both wrap the same JSON Schema `inputSchema` converts to;
 * only the envelope differs.
 */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

/**
 * Governs whether, and which, tool the model must call this turn. Meaningless without `tools`
 * set on the same request.
 *
 * Vendor mapping: `'auto'` — Anthropic `{type: 'auto'}`, OpenAI `'auto'` (both vendors' own
 * default when `tools` is set). `'none'` — Anthropic `{type: 'none'}`, OpenAI `'none'`: never
 * call a tool this turn. `'required'` — Anthropic `{type: 'any'}`, OpenAI `'required'`: call
 * some tool, model's choice which. `{ tool: name }` — Anthropic `{type: 'tool', name}`, OpenAI
 * `{type: 'function', function: {name}}`: force this specific tool.
 */
export type ModelToolChoice = 'auto' | 'none' | 'required' | { readonly tool: string };

/**
 * One invocation the model asked for during a `generate` call.
 *
 * Vendor mapping: Anthropic returns this as a `tool_use` content block in the assistant
 * message's `content` array (`{type: 'tool_use', id, name, input}`) — `id`/`name`/`input` map
 * across 1:1. OpenAI returns it as an entry in the assistant message's `tool_calls` array
 * (`{id, type: 'function', function: {name, arguments}}`), where `arguments` is a JSON-encoded
 * *string* that must be parsed into `input`, not the object itself.
 */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Vendor mapping for `role` together with `toolCalls`/`toolCallId`:
 * - `'user'` — Anthropic and OpenAI both: a plain `user` message.
 * - `'assistant'` with `toolCalls` set — Anthropic: an `assistant` message whose `content` array
 *   holds one `tool_use` block per call (plus a leading `text` block when `content` is
 *   non-empty). OpenAI: an `assistant` message carrying both `content` and a `tool_calls` array.
 * - `'tool'` — the result of running one tool call, identified by `toolCallId`. Anthropic has no
 *   dedicated tool-result role: it is sent as a `user` message whose `content` array holds a
 *   `tool_result` block (`{type: 'tool_result', tool_use_id, content}`). OpenAI gives it a role
 *   of its own: `{role: 'tool', tool_call_id, content}`.
 */
export interface ModelMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** Only meaningful on an `'assistant'` message — see the class doc comment's role mapping. */
  readonly toolCalls?: readonly ModelToolCall[];
  /** Only meaningful on a `'tool'` message: the `ModelToolCall.id` this result answers. */
  readonly toolCallId?: string;
}

export interface ModelRequest<TSchema extends z.ZodType | undefined = z.ZodType | undefined> {
  readonly taskClass: TaskClass;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly outputSchema?: TSchema;
  /** Passed through as the vendor `max_tokens` cap — bounds worst-case output spend. */
  readonly maxTokens: number;
  /** Refused before the call (fail closed) if the worst-case estimate exceeds this. */
  readonly maxCostUsd: number;
  /**
   * Cache-partitioning only — folded into `computeCacheKey` but never forwarded to the vendor
   * SDK (`AnthropicModelProvider` builds its request params from named fields, not a spread of
   * `request`). Without this, N identical-prompt extraction passes over the same chunk would all
   * hash to one cache key, and `CachingModelProvider`'s read-through `record` mode would let
   * passes 2..N silently replay pass 1's response instead of genuinely re-sampling.
   */
  readonly passOrdinal?: number;
  /**
   * Policy field, not part of the request's identity — attributes a call to a tenant's spend
   * ceiling (`SpendGuardModelProvider`). Deliberately excluded from `computeCacheKey`: two
   * identical prompts from different tenants must still hit the same cache entry, since the
   * replay cache is content-addressed on what was asked, not who asked it.
   */
  readonly tenantId?: string;
  /** Tools the model may call this turn — see `ModelToolDefinition`'s own doc comment for the
   * vendor mapping. Folded into `computeCacheKey`, omitted when absent: a request differing only
   * in which tools are offered is a different request, not a cache hit on an earlier tool-free
   * call, but a caller that never sets this must keep hashing identically to before this field
   * existed. */
  readonly tools?: readonly ModelToolDefinition[];
  /** See `ModelToolChoice`'s own doc comment for the vendor mapping. */
  readonly toolChoice?: ModelToolChoice;
}

export type ModelOutput<TSchema extends z.ZodType | undefined> = TSchema extends z.ZodType
  ? z.infer<TSchema>
  : string;

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/**
 * Vendor mapping: `'end_turn'` — Anthropic `stop_reason` of `'end_turn'` or `'stop_sequence'`,
 * OpenAI `finish_reason: 'stop'`. `'tool_use'` — Anthropic `'tool_use'`, OpenAI `'tool_calls'`:
 * the model wants to call one or more tools before it can continue. `'max_tokens'` — Anthropic
 * `'max_tokens'`, OpenAI `'length'`: truncated by `ModelRequest.maxTokens`.
 */
export type ModelStopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface ModelResult<TSchema extends z.ZodType | undefined = z.ZodType | undefined> {
  readonly output: ModelOutput<TSchema>;
  readonly usage: ModelUsage;
  readonly costUsd: number;
  /** Absent for a schema-constrained structured-output call (`outputSchema` set) — that shape
   * never invokes a tool, so `stopReason` only carries information once a caller offers `tools`.
   * See `ModelStopReason`'s own doc comment for the vendor mapping. */
  readonly stopReason?: ModelStopReason;
  /** Present only when `stopReason === 'tool_use'` — the calls a caller must execute and feed
   * back as `'tool'`-role `ModelMessage`s before calling `generate` again. See `ModelToolCall`'s
   * own doc comment for the vendor mapping. */
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelProviderInfo {
  readonly provider: string;
  readonly model: string;
}

export interface ModelProvider {
  readonly info: ModelProviderInfo;

  generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>>;
}

export const MODEL_PROVIDER = Symbol('MODEL_PROVIDER');
