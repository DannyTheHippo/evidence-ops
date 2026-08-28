import { getConnectionToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import type { EvidenceLocator } from '../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { EMBEDDING_PROVIDER } from '../../../src/providers/embedding/embedding-provider.interface';
import { FakeEmbeddingProvider } from '../../../src/providers/embedding/fake-embedding.provider';
import { AtlasSearchUnavailableError } from '../../../src/providers/retrieval/errors/atlas-search-unavailable.error';
import { RequiredSearchIndexesMissingError } from '../../../src/providers/retrieval/errors/required-search-indexes-missing.error';
import { MongoHybridRetrievalStore } from '../../../src/providers/retrieval/mongo-hybrid.store';
import type { RetrievalHit } from '../../../src/providers/retrieval/retrieval-store.interface';
import { SEARCH_INDEX, VECTOR_INDEX } from '../../../src/providers/retrieval/retrieval.constant';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

interface RawDocFixture {
  readonly _id: Types.ObjectId;
  readonly documentId: Types.ObjectId;
  readonly documentVersionId: Types.ObjectId;
  readonly text: string;
  readonly locator: EvidenceLocator;
  readonly tenantId: string;
}

interface SearchStageDoc {
  readonly $search: {
    readonly index: string;
    readonly compound: {
      readonly must: readonly {
        readonly text: { readonly query: string; readonly path: string };
      }[];
      readonly filter: readonly {
        readonly equals: { readonly path: string; readonly value: string };
      }[];
    };
  };
}

interface VectorSearchStageDoc {
  readonly $vectorSearch: {
    readonly index: string;
    readonly path: string;
    readonly queryVector: readonly number[];
    readonly numCandidates: number;
    readonly limit: number;
    readonly filter: { readonly tenantId: { readonly $eq: string } };
  };
}

interface LimitStageDoc {
  readonly $limit: number;
}

interface RankFusionStageDoc {
  readonly $rankFusion: {
    readonly input: {
      readonly pipelines: {
        readonly search: readonly [SearchStageDoc, LimitStageDoc];
        readonly vector: readonly [VectorSearchStageDoc];
      };
    };
    readonly combination: { readonly weights: Record<string, number> };
    readonly scoreDetails: boolean;
  };
}

/**
 * `jest.fn()` itself is untyped (`Mock<any, any, any>` — its zero-argument overload has no
 * generic to infer from). Left untyped here too, deliberately: giving this a declared return
 * type would only push the same "any assigned into a specific type" conflict onto every
 * `.mockReturnValue(...)`/`.mockReturnValueOnce(...)` call site below instead of resolving it.
 * `pipelineArg` is where a type gets attached — once, on the whole mock, immediately before
 * indexing `.mock.calls` — mirroring `ingestion.service.spec.ts`'s "recast the mock, not the
 * indexed result" pattern (casting the indexed result directly is what trips
 * `@typescript-eslint/no-unsafe-member-access`).
 */
function createAggregateMock() {
  return jest.fn();
}

/**
 * Every `search()` call now runs `assertAtlasSearchSupported` then `assertRequiredSearchIndexesExist`
 * before touching `aggregate` (see `mongo-hybrid.store.ts`'s `ensureSearchCapability`), so every
 * collection mock in this file needs a `listSearchIndexes` stub too — defaults to a healthy,
 * mongot-backed server with both required indexes `READY`/queryable so the existing behavioural
 * tests below stay about fusion/RRF, not the capability/index-existence guards.
 */
function buildCollectionMock(aggregate: ReturnType<typeof createAggregateMock>) {
  return {
    aggregate,
    listSearchIndexes: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { name: SEARCH_INDEX, status: 'READY', queryable: true },
        { name: VECTOR_INDEX, status: 'READY', queryable: true },
      ]),
    }),
  };
}

/** Reads the pipeline argument passed to the `callIndex`-th `.aggregate(...)` call. */
function pipelineArg<T>(aggregate: ReturnType<typeof createAggregateMock>, callIndex: number): T {
  const typed = aggregate as jest.Mock<{ toArray: jest.Mock<Promise<unknown[]>> }, [unknown[]]>;
  return typed.mock.calls[callIndex][0] as T;
}

function buildRawDoc(overrides: Partial<RawDocFixture> = {}): RawDocFixture {
  return {
    _id: new Types.ObjectId(),
    documentId: new Types.ObjectId(),
    documentVersionId: new Types.ObjectId(),
    text: 'a chunk of evidence text',
    locator: { kind: 'pdf-page', page: 1, extractorVersion: 'test-1' },
    tenantId: 'tenant-a',
    ...overrides,
  };
}

async function buildStore(
  connection: unknown,
  embeddingProvider: FakeEmbeddingProvider,
  fusion: 'server' | 'app' = 'server',
): Promise<MongoHybridRetrievalStore> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      MongoHybridRetrievalStore,
      { provide: getConnectionToken(), useValue: connection },
      { provide: EMBEDDING_PROVIDER, useValue: embeddingProvider },
      {
        provide: TypedConfigService,
        useValue: getMockTypedConfig({ retrieval: { fusion, limit: 12, scoreFloor: 0 } }),
      },
    ],
  }).compile();

  return module.get<MongoHybridRetrievalStore>(MongoHybridRetrievalStore);
}

describe('MongoHybridRetrievalStore', () => {
  let fakeEmbeddingProvider: FakeEmbeddingProvider;

  beforeEach(() => {
    fakeEmbeddingProvider = new FakeEmbeddingProvider();
  });

  it('should throw when the connection has no db handle', async () => {
    await expect(buildStore({ db: undefined }, fakeEmbeddingProvider)).rejects.toThrow(
      'Mongo connection has no active database handle',
    );
  });

  it('should throw when filter.tenantId is missing', async () => {
    const collection = jest.fn().mockReturnValue(buildCollectionMock(createAggregateMock()));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider);

    await expect(store.search({ text: 'cap rate', limit: 5 })).rejects.toThrow(
      'MongoHybridRetrievalStore requires a non-empty filter.tenantId',
    );
  });

  it('should throw when filter.tenantId is an empty string', async () => {
    const collection = jest.fn().mockReturnValue(buildCollectionMock(createAggregateMock()));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider);

    await expect(
      store.search({ text: 'cap rate', limit: 5, filter: { tenantId: '' } }),
    ).rejects.toThrow('MongoHybridRetrievalStore requires a non-empty filter.tenantId');
  });

  it('should embed the query text with input_type "query" when no vector is supplied', async () => {
    const aggregate = createAggregateMock();
    aggregate.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    const collection = jest.fn().mockReturnValue(buildCollectionMock(aggregate));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider);

    await store.search({ text: 'cap rate', limit: 5, filter: { tenantId: 'tenant-a' } });

    expect(fakeEmbeddingProvider.calls).toEqual([{ inputs: ['cap rate'], inputType: 'query' }]);
  });

  it('should skip embedding and use the supplied vector when the query already carries one', async () => {
    const aggregate = createAggregateMock();
    aggregate.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    const collection = jest.fn().mockReturnValue(buildCollectionMock(aggregate));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider);
    const suppliedVector = [0.1, 0.2, 0.3];

    await store.search({
      text: 'cap rate',
      vector: suppliedVector,
      limit: 5,
      filter: { tenantId: 'tenant-a' },
    });

    expect(fakeEmbeddingProvider.calls).toHaveLength(0);
    const pipeline = pipelineArg<[RankFusionStageDoc, LimitStageDoc, unknown]>(aggregate, 0);
    expect(pipeline[0].$rankFusion.input.pipelines.vector[0].$vectorSearch.queryVector).toEqual(
      suppliedVector,
    );
  });

  it('should build a tenant-scoped $rankFusion pipeline and normalize scoreDetails in server mode', async () => {
    const doc = buildRawDoc({ tenantId: 'tenant-a' });
    const aggregate = createAggregateMock();
    aggregate.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        {
          ...doc,
          fusionScore: 0.031,
          fusionScoreDetails: {
            value: 0.031,
            details: [
              { inputPipelineName: 'search', rank: 1, weight: 1, value: 0.0163934 },
              { inputPipelineName: 'vector', rank: 'NA', weight: 1, value: 'NA' },
            ],
          },
        },
      ]),
    });
    const collection = jest.fn().mockReturnValue(buildCollectionMock(aggregate));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'server');

    const hits = await store.search({
      text: 'cap rate',
      limit: 10,
      filter: { tenantId: 'tenant-a' },
    });

    expect(collection).toHaveBeenCalledWith('evidence_chunks');
    const pipeline = pipelineArg<[RankFusionStageDoc, LimitStageDoc, unknown]>(aggregate, 0);
    const [rankFusionStage, limitStage] = pipeline;
    expect(rankFusionStage.$rankFusion.input.pipelines.search[0].$search.compound.filter).toEqual([
      { equals: { path: 'tenantId', value: 'tenant-a' } },
    ]);
    expect(rankFusionStage.$rankFusion.input.pipelines.search[1]).toEqual({ $limit: 40 });
    expect(rankFusionStage.$rankFusion.input.pipelines.vector[0].$vectorSearch.filter).toEqual({
      tenantId: { $eq: 'tenant-a' },
    });
    expect(rankFusionStage.$rankFusion.input.pipelines.vector[0].$vectorSearch.numCandidates).toBe(
      400,
    );
    expect(rankFusionStage.$rankFusion.combination.weights).toEqual({ search: 1, vector: 1 });
    expect(rankFusionStage.$rankFusion.scoreDetails).toBe(true);
    expect(limitStage).toEqual({ $limit: 10 });

    expect(hits).toHaveLength(1);
    const hit = hits[0] as RetrievalHit<{
      readonly text: string;
      readonly documentId: string;
      readonly documentVersionId: string;
      readonly tenantId: string;
      readonly scoreBreakdown: readonly {
        readonly pipeline: string;
        readonly rank: number | null;
        readonly weight: number;
        readonly value: number | null;
      }[];
    }>;
    expect(hit.id).toBe(doc._id.toString());
    expect(hit.score).toBe(0.031);
    expect(hit.metadata.text).toBe(doc.text);
    expect(hit.metadata.documentId).toBe(doc.documentId.toString());
    expect(hit.metadata.documentVersionId).toBe(doc.documentVersionId.toString());
    expect(hit.metadata.tenantId).toBe('tenant-a');
    expect(hit.metadata.scoreBreakdown).toEqual([
      { pipeline: 'search', rank: 1, weight: 1, value: 0.0163934 },
      { pipeline: 'vector', rank: null, weight: 1, value: null },
    ]);
  });

  it('should return an empty scoreBreakdown when the server omits fusionScoreDetails', async () => {
    const doc = buildRawDoc();
    const aggregate = createAggregateMock();
    aggregate.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ ...doc, fusionScore: 0.02 }]),
    });
    const collection = jest.fn().mockReturnValue(buildCollectionMock(aggregate));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'server');

    const hits = await store.search({ text: 'q', limit: 5, filter: { tenantId: 'tenant-a' } });

    expect(hits[0].metadata).toMatchObject({ scoreBreakdown: [] });
  });

  it('should fuse two standalone pipelines with RRF (k=60) and rank a both-pipeline hit above single-pipeline hits in app mode', async () => {
    const searchOnlyDoc = buildRawDoc({ text: 'search-only hit' });
    const bothDoc = buildRawDoc({ text: 'hit in both pipelines' });
    const vectorOnlyDoc = buildRawDoc({ text: 'vector-only hit' });

    const aggregate = createAggregateMock();
    // Search pipeline: bothDoc rank 1, searchOnlyDoc rank 2.
    aggregate.mockReturnValueOnce({
      toArray: jest.fn().mockResolvedValue([bothDoc, searchOnlyDoc]),
    });
    // Vector pipeline: vectorOnlyDoc rank 1, bothDoc rank 2.
    aggregate.mockReturnValueOnce({
      toArray: jest.fn().mockResolvedValue([vectorOnlyDoc, bothDoc]),
    });
    const collection = jest.fn().mockReturnValue(buildCollectionMock(aggregate));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'app');

    const hits = await store.search({
      text: 'cap rate',
      vector: [0.1, 0.2],
      limit: 10,
      filter: { tenantId: 'tenant-a' },
    });

    expect(aggregate).toHaveBeenCalledTimes(2);
    const searchPipeline = pipelineArg<[SearchStageDoc, LimitStageDoc]>(aggregate, 0);
    const vectorPipeline = pipelineArg<[VectorSearchStageDoc]>(aggregate, 1);
    expect(searchPipeline[0].$search.compound.filter).toEqual([
      { equals: { path: 'tenantId', value: 'tenant-a' } },
    ]);
    expect(vectorPipeline[0].$vectorSearch.filter).toEqual({ tenantId: { $eq: 'tenant-a' } });

    // both: 1/(60+1) + 1/(60+2) ≈ 0.03252 > vector-only: 1/(60+1) ≈ 0.01639
    //      > search-only: 1/(60+2) ≈ 0.01613
    expect(hits.map((hit) => hit.id)).toEqual([
      bothDoc._id.toString(),
      vectorOnlyDoc._id.toString(),
      searchOnlyDoc._id.toString(),
    ]);

    const bothHit = hits[0] as RetrievalHit<{
      readonly scoreBreakdown: readonly {
        readonly pipeline: string;
        readonly rank: number | null;
        readonly weight: number;
        readonly value: number | null;
      }[];
    }>;
    expect(bothHit.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(bothHit.metadata.scoreBreakdown).toEqual([
      { pipeline: 'search', rank: 1, weight: 1, value: 1 / 61 },
      { pipeline: 'vector', rank: 2, weight: 1, value: 1 / 62 },
    ]);

    const vectorOnlyHit = hits[1];
    expect(vectorOnlyHit.score).toBeCloseTo(1 / 61, 10);
    const searchOnlyHit = hits[2];
    expect(searchOnlyHit.score).toBeCloseTo(1 / 62, 10);
  });

  it('should cap app-mode results at the requested limit after fusing', async () => {
    const docs = Array.from({ length: 3 }, () => buildRawDoc());
    const aggregate = createAggregateMock();
    aggregate.mockReturnValueOnce({ toArray: jest.fn().mockResolvedValue(docs) });
    aggregate.mockReturnValueOnce({ toArray: jest.fn().mockResolvedValue([]) });
    const collection = jest.fn().mockReturnValue(buildCollectionMock(aggregate));
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'app');

    const hits = await store.search({
      text: 'q',
      vector: [0.1],
      limit: 2,
      filter: { tenantId: 'tenant-a' },
    });

    expect(hits).toHaveLength(2);
  });

  it('should throw AtlasSearchUnavailableError, not a raw driver error, when listSearchIndexes rejects', async () => {
    const rawError = new Error("Unrecognized pipeline stage name: '$listSearchIndexes'");
    const listSearchIndexes = jest
      .fn()
      .mockReturnValue({ toArray: jest.fn().mockRejectedValue(rawError) });
    const aggregate = createAggregateMock();
    const collection = jest.fn().mockReturnValue({ aggregate, listSearchIndexes });
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'server');

    await expect(
      store.search({ text: 'cap rate', limit: 5, filter: { tenantId: 'tenant-a' } }),
    ).rejects.toThrow(AtlasSearchUnavailableError);

    // The property this check exists for: a server that fails the probe must never reach the
    // embedding call (real spend) or an aggregate call (the confusing raw error from the
    // motivating incident).
    expect(fakeEmbeddingProvider.calls).toHaveLength(0);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('should verify search capability in app mode too, not only server mode', async () => {
    const rawError = new Error("Unrecognized pipeline stage name: '$listSearchIndexes'");
    const listSearchIndexes = jest
      .fn()
      .mockReturnValue({ toArray: jest.fn().mockRejectedValue(rawError) });
    const aggregate = createAggregateMock();
    const collection = jest.fn().mockReturnValue({ aggregate, listSearchIndexes });
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'app');

    // `app` mode still runs `$search`/`$vectorSearch` directly (`searchAppSide`) against the
    // same mongot-backed indexes `server` mode's `$rankFusion` composes — a plain Mongo server
    // fails both modes identically confusingly, so the guard is not gated on the fusion mode.
    await expect(
      store.search({ text: 'cap rate', limit: 5, filter: { tenantId: 'tenant-a' } }),
    ).rejects.toThrow(AtlasSearchUnavailableError);
    // Capability fails first, so `assertRequiredSearchIndexesExist`'s own `listSearchIndexes`
    // call never runs — the `.then()` chain in `ensureSearchCapability` short-circuits.
    expect(listSearchIndexes).toHaveBeenCalledTimes(1);
  });

  it('should throw RequiredSearchIndexesMissingError, not run aggregate/embedding, when a required index is missing', async () => {
    const listSearchIndexes = jest.fn().mockReturnValue({
      // Capability check passes (list answers), but only the search index is present — the
      // exact shape of the incident this guard exists to catch (indexes lost, server still
      // mongot-backed).
      toArray: jest
        .fn()
        .mockResolvedValue([{ name: SEARCH_INDEX, status: 'READY', queryable: true }]),
    });
    const aggregate = createAggregateMock();
    const collection = jest.fn().mockReturnValue({ aggregate, listSearchIndexes });
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'server');

    await expect(
      store.search({ text: 'cap rate', limit: 5, filter: { tenantId: 'tenant-a' } }),
    ).rejects.toThrow(RequiredSearchIndexesMissingError);

    // Same property the capability guard already protects: a store that can't serve the query
    // must never reach the embedding call (real spend) or an aggregate call.
    expect(fakeEmbeddingProvider.calls).toHaveLength(0);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('should probe search capability and required indexes at most once per process across repeated searches', async () => {
    const aggregate = createAggregateMock();
    aggregate.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    const listSearchIndexes = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { name: SEARCH_INDEX, status: 'READY', queryable: true },
        { name: VECTOR_INDEX, status: 'READY', queryable: true },
      ]),
    });
    const collection = jest.fn().mockReturnValue({ aggregate, listSearchIndexes });
    const store = await buildStore({ db: { collection } }, fakeEmbeddingProvider, 'server');

    await store.search({ text: 'first', limit: 5, filter: { tenantId: 'tenant-a' } });
    await store.search({ text: 'second', limit: 5, filter: { tenantId: 'tenant-a' } });

    // 2, not 1: `ensureSearchCapability` chains two probes (`assertAtlasSearchSupported`, then
    // `assertRequiredSearchIndexesExist`), each calling `listSearchIndexes` once — but the whole
    // chain is memoized in a single promise, so both calls happen only during the first `search()`
    // and neither repeats on the second.
    expect(listSearchIndexes).toHaveBeenCalledTimes(2);
  });
});
