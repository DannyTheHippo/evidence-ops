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
export type TaskClass = 'qa_answer' | 'fact_extraction' | 'claim_verification';

/**
 * A tool advertised to an MCP client, not to a model — no `ModelProvider.generate` call in this
 * codebase takes `tools` (see `ModelRequest`'s own doc comment). `inputSchema` is a zod schema —
 * not JSON Schema directly — because `McpServerService.toMcpTool` converts it via `toJSONSchema`
 * the same way `structured-output-format.util.ts` converts `ModelRequest.outputSchema`, keeping
 * one shared conversion path rather than two.
 */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

/**
 * Vendor mapping for `role`:
 * - `'user'` — Anthropic and OpenAI both: a plain `user` message.
 * - `'assistant'` — Anthropic: an `assistant` message whose `content` array holds a `text` block.
 *   OpenAI: an `assistant` message carrying `content`.
 */
export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
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

export interface ModelResult<TSchema extends z.ZodType | undefined = z.ZodType | undefined> {
  readonly output: ModelOutput<TSchema>;
  readonly usage: ModelUsage;
  readonly costUsd: number;
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
