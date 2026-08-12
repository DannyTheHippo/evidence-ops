import type { mongo } from 'mongoose';
import type { EmbeddingProvider } from '../../src/providers/embedding/embedding-provider.interface';
import type { SearchByMode } from '../retrieval/retrieval-comparison';
import type { ModeRetrievalHit, RetrievalModeQuery } from '../retrieval/retrieval-modes';

// Deliberately no `db: mongo.Db` argument — a Qdrant search never touches Mongo, so a caller
// building this closure (over a `QdrantBenchmarkClient`, via `searchQdrantVector`) has nothing
// Mongo-shaped to bind. Keeping `db` out of this type is what forces that closure to exist at the
// call site rather than threading an unused Mongo handle through the Qdrant path.
export type QdrantSearch = (
  embeddingProvider: EmbeddingProvider,
  query: RetrievalModeQuery,
) => Promise<ModeRetrievalHit[]>;

/**
 * Builds the `SearchByMode` seam `runRetrievalComparison` calls once `modes` includes
 * `'qdrant-vector'`: routes that one mode to `qdrantSearch`, narrows everything else back to
 * `MongoRetrievalMode` and delegates to `mongoSearch`. This dispatch is the only interesting
 * branch in the whole Qdrant benchmark wiring — kept in its own pure factory, taking both
 * searches as plain functions, so it is the part that gets a unit test while the eventual
 * `eval/run.ts` wiring stays dumb (construct the two searches, call this, pass the result as
 * `search`).
 */
export function makeQdrantAwareSearch(
  mongoSearch: SearchByMode,
  qdrantSearch: QdrantSearch,
): SearchByMode {
  return (db: mongo.Db, embeddingProvider: EmbeddingProvider, mode, query) => {
    if (mode === 'qdrant-vector') {
      return qdrantSearch(embeddingProvider, query);
    }
    return mongoSearch(db, embeddingProvider, mode, query);
  };
}
