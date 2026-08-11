import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod/v4';
import { computeCacheKey } from './cache-key.util';
import { ModelReplayCacheMissError } from './errors/model-replay-cache-miss.error';
import type {
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
} from './model-provider.interface';
import { resolveSamplingTemperature } from './sampling-params';

export type ModelCacheMode = 'off' | 'record' | 'replay';

export interface CachingModelProviderOptions {
  readonly mode: ModelCacheMode;
  readonly cacheDir: string;
}

export const MODEL_CACHE_OPTIONS = Symbol('MODEL_CACHE_OPTIONS');

/**
 * Duck-typed on `.code` rather than `instanceof Error`: Node's own `fs/promises` errors are
 * constructed outside Jest's per-test VM realm, so `instanceof Error` is `false` for them under
 * this project's own test runner even though `.code` is set correctly — verified empirically
 * (plain Node: `instanceof Error` true; under `jest --config ./jest.config.ts`: false). `.code`
 * duck-typing is Node's documented idiom for this exact reason and is realm-independent.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * `off` — pass through, no cache read or write (normal live usage).
 * `record` — read-through: reuse an existing fixture if present, otherwise call live and
 *   persist the result, so a future eval runner replaying against these fixtures never re-pays
 *   for ones it already has.
 * `replay` — read-only: a miss throws rather than calling live (see `ModelReplayCacheMissError`).
 */
@Injectable()
export class CachingModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly options: CachingModelProviderOptions,
  ) {}

  get info(): ModelProviderInfo {
    return this.inner.info;
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    if (this.options.mode === 'off') {
      return this.inner.generate(request);
    }

    const key = computeCacheKey({
      provider: this.info.provider,
      model: this.info.model,
      maxTokens: request.maxTokens,
      // Resolved the same way `AnthropicModelProvider` resolves it for the actual request, so a
      // fixture recorded at one temperature is never replayed for a request that would now be
      // sent at another (see `CacheKeyInput.temperature`'s doc comment).
      temperature: resolveSamplingTemperature(request.taskClass),
      system: request.system,
      messages: request.messages,
      outputSchema: request.outputSchema,
    });

    const cached = await this.readCacheEntry<TSchema>(key);
    if (cached) {
      return cached;
    }

    if (this.options.mode === 'replay') {
      throw new ModelReplayCacheMissError(key);
    }

    const result = await this.inner.generate(request);
    await this.writeCacheEntry(key, result);
    return result;
  }

  private cachePath(key: string): string {
    return join(this.options.cacheDir, `${key}.json`);
  }

  private async readCacheEntry<TSchema extends z.ZodType | undefined>(
    key: string,
  ): Promise<ModelResult<TSchema> | undefined> {
    try {
      const raw = await readFile(this.cachePath(key), 'utf-8');
      // Trusted as-is, like any other fixture file — no re-validation against the caller's
      // zod schema on read. Fixtures are developer-authored/record-mode-generated, not
      // untrusted input.
      return JSON.parse(raw) as ModelResult<TSchema>;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async writeCacheEntry(key: string, result: ModelResult): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(this.cachePath(key), JSON.stringify(result), 'utf-8');
  }
}
