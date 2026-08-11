import { createHash } from 'node:crypto';
import { toJSONSchema, type z } from 'zod/v4';
import type { ModelMessage } from './model-provider.interface';

export interface CacheKeyInput {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly outputSchema?: z.ZodType;
  /** Cache-partitioning field only — see `ModelRequest.passOrdinal`'s own doc comment. */
  readonly passOrdinal?: number;
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
    params: { maxTokens: input.maxTokens },
    prompt: { system: input.system ?? null, messages: input.messages },
    schema: input.outputSchema ? toJSONSchema(input.outputSchema) : null,
    // Omitted entirely rather than coalesced to `null`, so a caller that never sets
    // `passOrdinal` (every request today outside the 3-pass extractor) hashes byte-identically to
    // before this field existed — every committed fixture under `eval/cache/model/` depends on
    // that. Only a caller that opts in changes the canonical shape at all.
    ...(input.passOrdinal === undefined ? {} : { passOrdinal: input.passOrdinal }),
  });

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
