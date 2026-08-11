import { createHash } from 'node:crypto';
import { toJSONSchema, type z } from 'zod/v4';
import type { ModelMessage } from './model-provider.interface';

export interface CacheKeyInput {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  /**
   * The resolved sampling temperature actually sent on the request — not the `taskClass` label
   * it was derived from (`sampling-params.ts`). Keying on the resolved value means a later change
   * to the class→temperature table invalidates old fixtures automatically; keying on the label
   * would silently serve a fixture recorded at a different temperature for the same class.
   */
  readonly temperature: number;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly outputSchema?: z.ZodType;
}

/**
 * Deterministic across object-key insertion order — required so the same logical request
 * always hashes to the same cache key regardless of how the caller built the request object.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, val]) => [key, sortKeysDeep(val)]));
  }

  return value;
}

/**
 * Cache key = hash of (provider, model, params, prompt, tools/schema). `maxCostUsd` is
 * deliberately excluded — it's a local refusal threshold, not a generation parameter, so two
 * requests differing only in budget cap should hit the same cache entry.
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const canonical = sortKeysDeep({
    provider: input.provider,
    model: input.model,
    params: { maxTokens: input.maxTokens, temperature: input.temperature },
    prompt: { system: input.system ?? null, messages: input.messages },
    schema: input.outputSchema ? toJSONSchema(input.outputSchema) : null,
  });

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
