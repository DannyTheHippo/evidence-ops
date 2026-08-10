/**
 * Provisional shape — no Mongo `$search`/`$vectorSearch`/`$rankFusion` implementation exists
 * yet (a later step owns that). Kept generic over the hit metadata so a concrete store can
 * layer its own document shape on top without changing this contract.
 */
export interface RetrievalQuery {
  readonly text: string;
  readonly vector?: readonly number[];
  readonly filter?: Record<string, unknown>;
  readonly limit: number;
}

export interface RetrievalHit<TMetadata = Record<string, unknown>> {
  readonly id: string;
  readonly score: number;
  readonly metadata: TMetadata;
}

export interface RetrievalStore {
  search<TMetadata = Record<string, unknown>>(
    query: RetrievalQuery,
  ): Promise<RetrievalHit<TMetadata>[]>;
}

export const RETRIEVAL_STORE = Symbol('RETRIEVAL_STORE');
