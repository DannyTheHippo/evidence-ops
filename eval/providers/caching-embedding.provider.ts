import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EmbeddingProvider,
  EmbeddingProviderInfo,
  EmbeddingRequest,
  EmbeddingResult,
} from '../../src/providers/embedding/embedding-provider.interface';
import { computeEmbeddingCacheKey } from './embedding-cache-key.util';
import { EmbeddingReplayCacheMissError } from './errors/embedding-replay-cache-miss.error';

export type EmbeddingCacheMode = 'off' | 'record' | 'replay';

export interface CachingEmbeddingProviderOptions {
  readonly mode: EmbeddingCacheMode;
  readonly cacheDir: string;
}

/**
 * Duck-typed on `.code`, same rationale as `CachingModelProvider`'s identical helper: Node's own
 * `fs/promises` errors are constructed outside Jest's per-test VM realm, so `instanceof Error` is
 * unreliable for them under this project's test runner even though `.code` is set correctly.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Record/replay decorator for `EmbeddingProvider`, structurally identical to
 * `src/providers/model/caching-model.provider.ts` but scoped to `eval/` rather than `src/`: the
 * eval harness's "replay runs at zero API cost and byte-stable" promise (ADR-0006) only holds if
 * *every* live call a run makes is cached, and `IngestionService`/`MongoHybridRetrievalStore` both
 * call `EmbeddingProvider.embed` directly — `CachingModelProvider` alone does not cover them.
 *
 * `off` — pass through, no cache read or write.
 * `record` — read-through: reuse an existing fixture if present, otherwise call live and persist.
 * `replay` — read-only: a miss throws (`EmbeddingReplayCacheMissError`) rather than calling live.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly options: CachingEmbeddingProviderOptions,
  ) {}

  get info(): EmbeddingProviderInfo {
    return this.inner.info;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (this.options.mode === 'off') {
      return this.inner.embed(request);
    }

    const key = computeEmbeddingCacheKey({
      provider: this.info.provider,
      model: this.info.model,
      dimensions: this.info.dimensions,
      inputType: request.inputType,
      inputs: request.inputs,
    });

    const cached = await this.readCacheEntry(key);
    if (cached) {
      return cached;
    }

    if (this.options.mode === 'replay') {
      throw new EmbeddingReplayCacheMissError(key);
    }

    const result = await this.inner.embed(request);
    await this.writeCacheEntry(key, result);
    return result;
  }

  private cachePath(key: string): string {
    return join(this.options.cacheDir, `${key}.json`);
  }

  private async readCacheEntry(key: string): Promise<EmbeddingResult | undefined> {
    try {
      const raw = await readFile(this.cachePath(key), 'utf-8');
      // Trusted as-is, like `CachingModelProvider`'s fixtures — developer-authored/record-mode
      // generated, not untrusted input.
      return JSON.parse(raw) as EmbeddingResult;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async writeCacheEntry(key: string, result: EmbeddingResult): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(this.cachePath(key), JSON.stringify(result), 'utf-8');
  }
}
