import { createHash } from 'node:crypto';
import { toJSONSchema, type z } from 'zod/v4';
import type {
  ModelMessage,
  ModelToolChoice,
  ModelToolDefinition,
} from './model-provider.interface';

export interface CacheKeyInput {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly outputSchema?: z.ZodType;
  /** Cache-partitioning field only — see `ModelRequest.passOrdinal`'s own doc comment. */
  readonly passOrdinal?: number;
  /** See `ModelRequest.tools`'s own doc comment for the omit-when-absent contract. */
  readonly tools?: readonly ModelToolDefinition[];
  /** See `ModelRequest.toolChoice`'s own doc comment. */
  readonly toolChoice?: ModelToolChoice;
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
    // Same omit-when-absent treatment: a request without tools (every non-agentic caller) must
    // keep hashing identically to a request built before this field existed, so it is omitted
    // rather than coalesced to `null`.
    ...(input.tools === undefined
      ? {}
      : {
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: toJSONSchema(tool.inputSchema),
          })),
        }),
    ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
  });

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
