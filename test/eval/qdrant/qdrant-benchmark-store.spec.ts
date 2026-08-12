import { Types } from 'mongoose';
import {
  populateQdrantCollection,
  searchQdrantVector,
  QDRANT_BENCHMARK_COLLECTION,
  type QdrantBenchmarkClient,
} from '../../../eval/qdrant/qdrant-benchmark-store';
import type { RawEvidenceChunkRow } from '../../../eval/qdrant/chunk-to-point.util';
import { chunkIdToPointId } from '../../../eval/qdrant/qdrant-point-id.util';
import { FakeEmbeddingProvider } from '../../../src/providers/embedding/fake-embedding.provider';

function buildRow(overrides: Partial<RawEvidenceChunkRow> = {}): RawEvidenceChunkRow {
  return {
    _id: 'c'.repeat(64),
    embedding: [0.1, 0.2, 0.3],
    documentVersionId: new Types.ObjectId('507f1f77bcf86cd799439011'),
    text: 'The cap rate is 6.5%.',
    locator: { kind: 'pdf-page', page: 3, extractorVersion: 'pdf-v1' },
    tenantId: 'eval',
    ...overrides,
  };
}

function buildClient(
  overrides: Partial<QdrantBenchmarkClient> = {},
): jest.Mocked<QdrantBenchmarkClient> {
  return {
    collectionExists: jest.fn().mockResolvedValue({ exists: false }),
    deleteCollection: jest.fn().mockResolvedValue(true),
    createCollection: jest.fn().mockResolvedValue(true),
    upsert: jest.fn().mockResolvedValue({ operation_id: 0, status: 'completed' }),
    query: jest.fn().mockResolvedValue({ points: [] }),
    ...overrides,
  } as jest.Mocked<QdrantBenchmarkClient>;
}

describe('populateQdrantCollection', () => {
  afterEach(() => jest.resetAllMocks());

  it('should delete the existing collection before creating the new one', async () => {
    const client = buildClient({ collectionExists: jest.fn().mockResolvedValue({ exists: true }) });

    await populateQdrantCollection(client, [buildRow()]);

    expect(client.deleteCollection).toHaveBeenCalledWith(QDRANT_BENCHMARK_COLLECTION);
    expect(client.deleteCollection.mock.invocationCallOrder[0]).toBeLessThan(
      client.createCollection.mock.invocationCallOrder[0],
    );
  });

  it('should skip deletion when no collection exists yet', async () => {
    const client = buildClient({
      collectionExists: jest.fn().mockResolvedValue({ exists: false }),
    });

    await populateQdrantCollection(client, [buildRow()]);

    expect(client.deleteCollection).not.toHaveBeenCalled();
    expect(client.createCollection).toHaveBeenCalledWith(
      QDRANT_BENCHMARK_COLLECTION,
      expect.objectContaining({ vectors: { size: 3, distance: 'Cosine' } }),
    );
  });

  it('should upsert the mapped points with wait: true', async () => {
    const client = buildClient();
    const row = buildRow();

    await populateQdrantCollection(client, [row]);

    expect(client.upsert).toHaveBeenCalledWith(QDRANT_BENCHMARK_COLLECTION, {
      wait: true,
      points: [
        {
          id: chunkIdToPointId(row._id),
          vector: [...row.embedding],
          payload: {
            chunkId: row._id,
            documentVersionId: row.documentVersionId.toString(),
            text: row.text,
            locator: row.locator,
            tenantId: row.tenantId,
          },
        },
      ],
    });
  });
});

describe('searchQdrantVector', () => {
  afterEach(() => jest.resetAllMocks());

  it('should embed the query text with inputType: "query"', async () => {
    const client = buildClient();
    const embeddingProvider = new FakeEmbeddingProvider();

    await searchQdrantVector(client, embeddingProvider, {
      text: 'What is the cap rate?',
      tenantId: 'eval',
      limit: 10,
    });

    expect(embeddingProvider.calls).toEqual([
      { inputs: ['What is the cap rate?'], inputType: 'query' },
    ]);
  });

  it('should search with the limit, with_payload, and a tenantId filter', async () => {
    const client = buildClient();
    const embeddingProvider = new FakeEmbeddingProvider();

    await searchQdrantVector(client, embeddingProvider, {
      text: 'What is the cap rate?',
      tenantId: 'tenant-1',
      limit: 5,
    });

    expect(client.query).toHaveBeenCalledWith(QDRANT_BENCHMARK_COLLECTION, {
      query: [0, 0, 0, 0],
      limit: 5,
      with_payload: true,
      filter: { must: [{ key: 'tenantId', match: { value: 'tenant-1' } }] },
    });
  });

  it('should map Qdrant hits to the same ModeRetrievalHit shape the Mongo modes return', async () => {
    const locator = { kind: 'pdf-page' as const, page: 3, extractorVersion: 'pdf-v1' };
    const client = buildClient({
      query: jest.fn().mockResolvedValue({
        points: [
          {
            id: 'point-1',
            version: 0,
            score: 0.9,
            payload: {
              chunkId: 'chunk-1',
              documentVersionId: 'docver-1',
              text: 'The cap rate is 6.5%.',
              locator,
              tenantId: 'eval',
            },
          },
        ],
      }),
    });

    const hits = await searchQdrantVector(client, new FakeEmbeddingProvider(), {
      text: 'What is the cap rate?',
      tenantId: 'eval',
      limit: 5,
    });

    expect(hits).toEqual([
      {
        chunkId: 'chunk-1',
        documentVersionId: 'docver-1',
        text: 'The cap rate is 6.5%.',
        locator,
      },
    ]);
  });

  it('should throw when a returned point has no payload', async () => {
    const client = buildClient({
      query: jest.fn().mockResolvedValue({ points: [{ id: 'point-1', version: 0, score: 0.9 }] }),
    });

    await expect(
      searchQdrantVector(client, new FakeEmbeddingProvider(), {
        text: 'What is the cap rate?',
        tenantId: 'eval',
        limit: 5,
      }),
    ).rejects.toThrow('with_payload: true');
  });
});
