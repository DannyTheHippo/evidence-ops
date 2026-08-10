import { Injectable } from '@nestjs/common';
import type { RetrievalHit, RetrievalQuery, RetrievalStore } from './retrieval-store.interface';

/** Test double: returns whatever hits the test seeds via `setHits()`, ignoring the query. */
@Injectable()
export class FakeRetrievalStore implements RetrievalStore {
  readonly queries: RetrievalQuery[] = [];

  private hits: RetrievalHit[] = [];

  setHits(hits: RetrievalHit[]): void {
    this.hits = hits;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async search<TMetadata = Record<string, unknown>>(
    query: RetrievalQuery,
  ): Promise<RetrievalHit<TMetadata>[]> {
    this.queries.push(query);
    return this.hits as RetrievalHit<TMetadata>[];
  }
}
