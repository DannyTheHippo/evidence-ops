import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../shared/services/logger/logger.service';

export interface QueryEmbeddingCacheKey {
  readonly tenantId: string;
  readonly text: string;
  readonly model: string;
}

interface CacheEntry {
  readonly vector: readonly number[];
  readonly expiresAt: number;
}

/** A tenant on a different embedding model, or the same tenant re-asking after the TTL, must
 *  never reuse another entry's vector — cheap in-process caches like this one are how a subtle
 *  cross-tenant leak or a stale-model mismatch gets introduced, so every component of the key is
 *  load-bearing, not just `text`. */
const buildCacheKey = ({ tenantId, text, model }: QueryEmbeddingCacheKey): string =>
  JSON.stringify([tenantId, model, text]);

export const MAX_ENTRIES = 200;
export const TTL_MS = 5 * 60 * 1000;

/**
 * In-process, per-worker cache of query embeddings, keyed by tenant + query text + embedding
 * model. Bounded to `MAX_ENTRIES` with least-recently-used eviction (a `Map`'s iteration order is
 * insertion order, so re-inserting an entry on every read or write moves it to the end and the
 * oldest surviving key is always the one at the front) and expires an entry after `TTL_MS`
 * regardless of how often it was read.
 *
 * Fails OPEN: `getOrCompute` never lets a broken cache block retrieval. A miss falls through to
 * `compute`; a read or write failure on the cache's own bookkeeping is caught, logged, and
 * likewise falls through — the one call that is never suppressed is `compute` itself, so a live
 * embedding failure still surfaces as a real error.
 */
@Injectable()
export class QueryEmbeddingCacheService {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly logger: AppLogger) {
    this.logger.init(QueryEmbeddingCacheService.name);
  }

  async getOrCompute(
    key: QueryEmbeddingCacheKey,
    compute: () => Promise<readonly number[]>,
  ): Promise<readonly number[]> {
    const cacheKey = buildCacheKey(key);

    try {
      const cached = this.read(cacheKey);
      if (cached) {
        return cached;
      }
    } catch (error) {
      this.logger.warn(
        `Query-embedding cache read failed, computing live instead: ${String(error)}`,
      );
    }

    const vector = await compute();

    try {
      this.write(cacheKey, vector);
    } catch (error) {
      this.logger.warn(`Query-embedding cache write failed, entry not cached: ${String(error)}`);
    }

    return vector;
  }

  private read(cacheKey: string): readonly number[] | undefined {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return entry.vector;
  }

  private write(cacheKey: string, vector: readonly number[]): void {
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, { vector, expiresAt: Date.now() + TTL_MS });

    if (this.entries.size > MAX_ENTRIES) {
      // `size > MAX_ENTRIES` (>= 1) already proves the map is non-empty, so the iterator's first
      // key can never be `undefined` here — the non-null assertion reflects that invariant rather
      // than skipping a check a genuinely empty map would need.
      const oldestKey = this.entries.keys().next().value!;
      this.entries.delete(oldestKey);
    }
  }
}
