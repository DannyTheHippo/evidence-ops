import type { z } from 'zod/v4';

/**
 * Deliberate convention exception: `.claude/CLAUDE.md` says "zod is env-only; requests use
 * class-validator". That rule targets HTTP DTOs. The provider layer uses zod as the schema
 * language for model input/output because the schema must convert to JSON Schema for
 * Anthropic's `output_format` and be reusable by the eval harness. Scoped to `src/providers/**`
 * and model contracts only.
 *
 * `zod/v4` specifically (not the bare `zod` import, which resolves to v3 in this package's
 * transitional 3.25.x release) — `@anthropic-ai/sdk`'s `zodOutputFormat()` helper requires a
 * v4 `ZodType` and v3/v4 schema instances are not interchangeable at runtime.
 */
export type TaskClass = 'qa_answer' | 'fact_extraction';

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
