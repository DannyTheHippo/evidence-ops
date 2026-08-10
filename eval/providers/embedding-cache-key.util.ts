import { createHash } from 'node:crypto';
import type { EmbeddingInputType } from '../../src/providers/embedding/embedding-provider.interface';

/**
 * Mirrors `src/providers/model/cache-key.util.ts`'s shape (hash of provider/model/params/input),
 * scoped to embeddings: `dimensions` and `inputType` are generation parameters here the way
 * `maxTokens`/`outputSchema` are for a model call — Voyage's asymmetric embeddings mean the same
 * text embedded as `'query'` vs `'document'` are different vectors, so a cache key that ignored
 * `inputType` would silently serve a document-side vector to a query-side caller.
 */
export interface EmbeddingCacheKeyInput {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly inputType: EmbeddingInputType;
  readonly inputs: readonly string[];
}

export function computeEmbeddingCacheKey(input: EmbeddingCacheKeyInput): string {
  const canonical = {
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    inputType: input.inputType,
    inputs: input.inputs,
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
