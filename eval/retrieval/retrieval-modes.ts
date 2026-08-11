import type { mongo } from 'mongoose';
import type { EvidenceLocator } from '../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { EmbeddingProvider } from '../../src/providers/embedding/embedding-provider.interface';

/**
 * Eval-side retrieval-mode aggregations for the ADR-0007 comparison table (work item 3): lexical
 * only ($search), vector only ($vectorSearch), and hybrid ($rankFusion) against the frozen corpus,
 * varying only which pipeline(s) run. Deliberately re-implemented here rather than extending
 * `src/providers/retrieval/mongo-hybrid.store.ts`, for two reasons: (1) this change's scope is
 * `eval/`, `package.json`, and `docs/adr/0007-*.md` — the retrieval store is out of grant; (2) the
 * store's own constants comment already establishes the project's convention of duplicating
 * index/collection names rather than importing across the `src`/other-root boundary
 * (`tsconfig.build.json` scopes `rootDir` to `src`), and the same reasoning applies one step
 * further out, from `src` to `eval`.
 *
 * Every tuning constant below (index names, RRF k, pipeline weights, candidate-pool multipliers)
 * is copied verbatim from `mongo-hybrid.store.ts` so the "fair comparison" protocol holds: the
 * *only* thing that varies between `searchByMode` calls is which stages run, never a pool size or
 * a weight recomputed differently by two code paths that are supposed to mean the same thing.
 */
export type RetrievalMode = 'lexical' | 'vector' | 'hybrid';
export const RETRIEVAL_MODES: readonly RetrievalMode[] = ['lexical', 'vector', 'hybrid'];

const COLLECTION = 'evidence_chunks';
const SEARCH_INDEX = 'evidence_chunks_search';
const VECTOR_INDEX = 'evidence_chunks_vector';

const PIPELINE_WEIGHTS = { search: 1, vector: 1 };
const RRF_K = 60;
const PIPELINE_CANDIDATE_MULTIPLIER = 4;
const MIN_PIPELINE_CANDIDATES = 20;
const VECTOR_NUM_CANDIDATES_MULTIPLIER = 10;
const MIN_VECTOR_NUM_CANDIDATES = 100;

export interface ModeRetrievalHit {
  readonly chunkId: string;
  readonly documentVersionId: string;
  readonly text: string;
  readonly locator: EvidenceLocator;
}

interface RawEvidenceChunkDoc {
  readonly _id: mongo.ObjectId;
  readonly documentVersionId: mongo.ObjectId;
  readonly text: string;
  readonly locator: EvidenceLocator;
  readonly tenantId: string;
}

export interface RetrievalModeQuery {
  readonly text: string;
  readonly tenantId: string;
  readonly limit: number;
}

function buildSearchStages(text: string, tenantId: string, limit: number): mongo.Document[] {
  return [
    {
      $search: {
        index: SEARCH_INDEX,
        compound: {
          must: [{ text: { query: text, path: 'text' } }],
          filter: [{ equals: { path: 'tenantId', value: tenantId } }],
        },
      },
    },
    { $limit: limit },
  ];
}

function buildVectorStages(
  vector: readonly number[],
  tenantId: string,
  limit: number,
): mongo.Document[] {
  return [
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: 'embedding',
        queryVector: vector,
        numCandidates: Math.max(
          limit * VECTOR_NUM_CANDIDATES_MULTIPLIER,
          MIN_VECTOR_NUM_CANDIDATES,
        ),
        limit,
        filter: { tenantId: { $eq: tenantId } },
      },
    },
  ];
}

function toHit(doc: RawEvidenceChunkDoc): ModeRetrievalHit {
  return {
    chunkId: doc._id.toString(),
    documentVersionId: doc.documentVersionId.toString(),
    // Same aggregation the doc was already fetched by (no `$project` stage strips it) — the
    // production store's equivalent mapping (`mongo-hybrid.store.ts`'s `toHit`) already surfaces
    // this field for the same reason; there is no second query to make here.
    text: doc.text,
    locator: doc.locator,
  };
}

async function embedQuery(
  embeddingProvider: EmbeddingProvider,
  text: string,
): Promise<readonly number[]> {
  // 'query', not 'document' — same asymmetric-embedding requirement as
  // `MongoHybridRetrievalStore.embedQuery`.
  const result = await embeddingProvider.embed({ inputs: [text], inputType: 'query' });
  return result.embeddings[0];
}

/**
 * Runs one retrieval mode against the live `evidence_chunks` collection and returns exactly
 * `query.limit` hits, already ranked. `lexical`/`vector` run a single pipeline capped directly at
 * `query.limit` (there is no fusion step to feed a wider candidate pool into); `hybrid` widens
 * each input pipeline to a `PIPELINE_CANDIDATE_MULTIPLIER`-sized pool before `$rankFusion`, exactly
 * as `mongo-hybrid.store.ts`'s server-side path does.
 */
export async function searchByMode(
  db: mongo.Db,
  embeddingProvider: EmbeddingProvider,
  mode: RetrievalMode,
  query: RetrievalModeQuery,
): Promise<ModeRetrievalHit[]> {
  const collection = db.collection<RawEvidenceChunkDoc>(COLLECTION);

  if (mode === 'lexical') {
    const docs = await collection
      .aggregate<RawEvidenceChunkDoc>(buildSearchStages(query.text, query.tenantId, query.limit))
      .toArray();
    return docs.map(toHit);
  }

  const vector = await embedQuery(embeddingProvider, query.text);

  if (mode === 'vector') {
    const docs = await collection
      .aggregate<RawEvidenceChunkDoc>(buildVectorStages(vector, query.tenantId, query.limit))
      .toArray();
    return docs.map(toHit);
  }

  const pipelineLimit = Math.max(
    query.limit * PIPELINE_CANDIDATE_MULTIPLIER,
    MIN_PIPELINE_CANDIDATES,
  );
  const docs = await collection
    .aggregate<RawEvidenceChunkDoc>([
      {
        $rankFusion: {
          input: {
            pipelines: {
              search: buildSearchStages(query.text, query.tenantId, pipelineLimit),
              vector: buildVectorStages(vector, query.tenantId, pipelineLimit),
            },
          },
          combination: { weights: PIPELINE_WEIGHTS },
        },
      },
      { $limit: query.limit },
    ])
    .toArray();
  return docs.map(toHit);
}

// Exported for `docs/adr/0007-eval-replay-cache.md` and for a future test asserting the RRF
// constant matches the store's — not consumed by `searchByMode` itself (the fused ranking is
// computed server-side by `$rankFusion`).
export const RETRIEVAL_MODE_TUNING = { RRF_K, PIPELINE_WEIGHTS } as const;
