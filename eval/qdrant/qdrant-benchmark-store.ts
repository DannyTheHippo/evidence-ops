import type { QdrantClient } from '@qdrant/js-client-rest';
import type { EmbeddingProvider } from '../../src/providers/embedding/embedding-provider.interface';
import type { ModeRetrievalHit, RetrievalModeQuery } from '../retrieval/retrieval-modes';
import {
  toPoint,
  assertUniformEmbeddingLength,
  type QdrantPointPayload,
  type RawEvidenceChunkRow,
} from './chunk-to-point.util';

// Deliberately not `evidence_chunks` (the Mongo collection name in `retrieval-modes.ts`) — this
// collection only ever holds the eval corpus's benchmark run, never production data, and the
// distinct name keeps that boundary visible in any Qdrant admin UI.
export const QDRANT_BENCHMARK_COLLECTION = 'evidence_chunks_benchmark';

// Narrowed to exactly the `QdrantClient` methods this module calls, so a unit test can mock
// against the real interface (`jest-tests.md`'s "type mocks against the real interface") without
// standing up the full client surface.
export type QdrantBenchmarkClient = Pick<
  QdrantClient,
  'collectionExists' | 'deleteCollection' | 'createCollection' | 'upsert' | 'query'
>;

/**
 * Recreates `QDRANT_BENCHMARK_COLLECTION` from `rows` and waits for the write to be visible.
 *
 * Deletes the collection first rather than upserting into whatever is already there: a Qdrant
 * container left running between benchmark runs would otherwise accumulate stale points from a
 * previous corpus, silently inflating recall with chunks the current run never indexed.
 *
 * `wait: true` on the upsert is mandatory, not a tuning knob — this function's whole purpose is
 * "populate, then the caller immediately searches", and Qdrant's default (`wait` unset) can
 * return from `upsert` before the points are actually searchable, racing the very next query.
 *
 * `distance: 'Cosine'` mirrors `migrations/0003-search-indexes.ts`'s vector index (see that
 * file's comment on `buildVectorIndex`, ~lines 67-73): nothing in `VoyageEmbeddingProvider`
 * requests or asserts unit-length vectors from the Voyage API, so `dotProduct`/`Dot` would only be
 * equivalent to cosine similarity by an unconfirmed assumption — and getting it wrong doesn't
 * error, it just silently mis-ranks.
 */
export async function populateQdrantCollection(
  client: QdrantBenchmarkClient,
  rows: readonly RawEvidenceChunkRow[],
): Promise<void> {
  const { exists } = await client.collectionExists(QDRANT_BENCHMARK_COLLECTION);
  if (exists) {
    await client.deleteCollection(QDRANT_BENCHMARK_COLLECTION);
  }

  await client.createCollection(QDRANT_BENCHMARK_COLLECTION, {
    vectors: { size: assertUniformEmbeddingLength(rows), distance: 'Cosine' },
  });

  const points = rows.map(toPoint).map((point) => ({
    id: point.id,
    // `toPoint`'s `vector`/`payload` are `readonly` (see `chunk-to-point.util.ts`); the client's
    // point struct wants plain mutable values.
    vector: [...point.vector],
    payload: { ...point.payload },
  }));
  await client.upsert(QDRANT_BENCHMARK_COLLECTION, { wait: true, points });
}

function toHit(
  payload: QdrantPointPayload | Record<string, unknown> | null | undefined,
): ModeRetrievalHit {
  // Fails CLOSED: `with_payload: true` is always passed below, so a missing payload here means
  // the collection was populated wrong (or queried against the wrong one), not a hit to skip
  // silently — same posture as `chunkIdToPointId`/`assertUniformEmbeddingLength`.
  if (!payload) {
    throw new Error('Qdrant search returned a point with no payload despite `with_payload: true`');
  }
  const { chunkId, documentVersionId, text, locator } = payload as QdrantPointPayload;
  return { chunkId, documentVersionId, text, locator };
}

/**
 * Dense-only vector search against `QDRANT_BENCHMARK_COLLECTION`, shaped to return the same
 * `ModeRetrievalHit[]` the Mongo modes in `retrieval-modes.ts` return so the comparison table can
 * score every mode identically.
 */
export async function searchQdrantVector(
  client: QdrantBenchmarkClient,
  embeddingProvider: EmbeddingProvider,
  query: RetrievalModeQuery,
): Promise<ModeRetrievalHit[]> {
  // 'query', not 'document' — mirrors `retrieval-modes.ts`'s `embedQuery` (~line 113) exactly.
  // The eval's embedding cache keys on `{provider, model, dimensions, inputType, inputs}`; any
  // deviation here (wrong inputType, a differently-shaped `inputs` array) turns a free cache
  // replay into a paid Voyage API call.
  const embedded = await embeddingProvider.embed({ inputs: [query.text], inputType: 'query' });
  const vector = embedded.embeddings[0];

  const response = await client.query(QDRANT_BENCHMARK_COLLECTION, {
    query: [...vector],
    limit: query.limit,
    with_payload: true,
    filter: { must: [{ key: 'tenantId', match: { value: query.tenantId } }] },
  });

  return response.points.map((point) => toHit(point.payload));
}
