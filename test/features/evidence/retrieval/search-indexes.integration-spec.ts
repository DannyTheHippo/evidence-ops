import { randomUUID } from 'node:crypto';
import { Db, MongoClient, ObjectId } from 'mongodb';
import {
  COLLECTION,
  SEARCH_INDEX,
  VECTOR_INDEX,
  resolveVectorDimensions,
} from '../../../../migrations/0003-search-indexes';
import { waitForSearchIndexReady } from '../../../../src/features/evidence/retrieval/search-index-readiness.util';

/**
 * Proves `migrations/0003-search-indexes.ts` against a real `mongodb/mongodb-atlas-local`
 * container — `mongodb-memory-server` (used by unit/e2e specs) cannot serve `$search` or
 * `$vectorSearch`. Requires `docker compose up -d mongo` and `npm run migrate:up` to have
 * already run (`CLAUDE.md` § Validation); this spec asserts against the indexes those steps
 * created, it does not create them, so re-running it never collides with `createSearchIndexes`.
 *
 * Reading `MONGO_DB_URI` directly mirrors `migrate-mongo-config.js`'s own pattern — this file
 * runs outside Nest's DI, same as a migration, so `TypedConfigService` is unavailable.
 */
const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

// Short relative to the migration's own 120s budget — by the time this spec runs, `migrate:up`
// has already waited for READY+queryable once. This just confirms it from a fresh connection.
const READINESS_TIMEOUT_MS = 15_000;

const TENANT_ID = `search-index-it-${randomUUID()}`;
const MARKER = `search-index-marker-${randomUUID()}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `$search`/`$vectorSearch` indexing is eventually consistent — an insert followed by an
 *  immediate query is a flake factory. Retries the aggregation until it sees at least one
 *  result or the budget runs out. */
async function retryUntilFound<T>(
  run: () => Promise<T[]>,
  { timeoutMs = 20_000, intervalMs = 500 } = {},
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const results = await run();
    if (results.length > 0 || Date.now() >= deadline) {
      return results;
    }
    await sleep(intervalMs);
  }
}

function buildSeedEmbedding(dimensions: number): number[] {
  // A fixed, deterministic vector — the vector-search assertion queries with this exact vector,
  // so the seeded chunk is guaranteed to be its own nearest neighbour regardless of magnitude.
  return Array.from({ length: dimensions }, (_, i) => (i % 7) / 7);
}

/**
 * The native driver's `Document` type is `{ [key: string]: any }` (`bson.d.ts`); operating on
 * an untyped collection would make every field access here an ESLint `no-unsafe-*` violation.
 * `_id` is declared explicitly (rather than left to inference) so `InsertOneResult`'s
 * `InferIdType` resolves to `ObjectId` instead of collapsing to `never`.
 */
interface EvidenceChunkTestDoc {
  _id?: ObjectId;
  documentId: ObjectId;
  documentVersionId: ObjectId;
  text: string;
  tokenCount: number;
  embedding: number[];
  locator: Record<string, unknown>;
  tenantId: string;
}

describe('evidence_chunks search indexes (integration)', () => {
  let client: MongoClient;
  let db: Db;
  let seededChunkId: ObjectId;
  let seededDocumentId: ObjectId;
  let seededDocumentVersionId: ObjectId;
  let embedding: number[];

  beforeAll(async () => {
    client = new MongoClient(MONGO_DB_URI);
    await client.connect();
    db = client.db();

    embedding = buildSeedEmbedding(resolveVectorDimensions());
    seededDocumentId = new ObjectId();
    seededDocumentVersionId = new ObjectId();

    const insertResult = await db.collection<EvidenceChunkTestDoc>(COLLECTION).insertOne({
      documentId: seededDocumentId,
      documentVersionId: seededDocumentVersionId,
      text: `This chunk exists only to be found by the marker token ${MARKER}.`,
      tokenCount: 12,
      embedding,
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'search-index-it' },
      tenantId: TENANT_ID,
    });
    seededChunkId = insertResult.insertedId;
  });

  afterAll(async () => {
    if (db) {
      await db.collection<EvidenceChunkTestDoc>(COLLECTION).deleteOne({ _id: seededChunkId });
    }
    await client?.close();
  });

  it('should report both indexes READY and queryable', async () => {
    await expect(
      waitForSearchIndexReady(db, COLLECTION, SEARCH_INDEX, { timeoutMs: READINESS_TIMEOUT_MS }),
    ).resolves.toBeUndefined();
    await expect(
      waitForSearchIndexReady(db, COLLECTION, VECTOR_INDEX, { timeoutMs: READINESS_TIMEOUT_MS }),
    ).resolves.toBeUndefined();
  });

  it('should find the seeded chunk via $search, pre-filtered by tenantId, documentId and documentVersionId', async () => {
    // Exercises all three mapped filter fields, not just `tenantId` — the `token`/`objectId`
    // mappings for the reference fields are otherwise unverified: a mistyped field mapping
    // (e.g. `objectId` on a field that isn't actually stored as one) fails `equals` silently
    // by matching nothing, which looks identical to "no results for this query" from outside.
    const results = await retryUntilFound(() =>
      db
        .collection<EvidenceChunkTestDoc>(COLLECTION)
        .aggregate<EvidenceChunkTestDoc>([
          {
            $search: {
              index: SEARCH_INDEX,
              compound: {
                must: [{ text: { query: MARKER, path: 'text' } }],
                filter: [
                  { equals: { path: 'tenantId', value: TENANT_ID } },
                  { equals: { path: 'documentId', value: seededDocumentId } },
                  { equals: { path: 'documentVersionId', value: seededDocumentVersionId } },
                ],
              },
            },
          },
          { $limit: 1 },
        ])
        .toArray(),
    );

    expect(results).toHaveLength(1);
    expect(results[0]._id).toEqual(seededChunkId);
  });

  it('should not find the seeded chunk via $search when filtered to a different tenantId', async () => {
    const results = await db
      .collection<EvidenceChunkTestDoc>(COLLECTION)
      .aggregate<EvidenceChunkTestDoc>([
        {
          $search: {
            index: SEARCH_INDEX,
            compound: {
              must: [{ text: { query: MARKER, path: 'text' } }],
              filter: [{ equals: { path: 'tenantId', value: `${TENANT_ID}-other` } }],
            },
          },
        },
        { $limit: 1 },
      ])
      .toArray();

    expect(results).toHaveLength(0);
  });

  it('should find the seeded chunk via $vectorSearch, pre-filtered by tenantId', async () => {
    const results = await retryUntilFound(() =>
      db
        .collection<EvidenceChunkTestDoc>(COLLECTION)
        .aggregate<EvidenceChunkTestDoc>([
          {
            $vectorSearch: {
              index: VECTOR_INDEX,
              path: 'embedding',
              queryVector: embedding,
              numCandidates: 10,
              limit: 1,
              filter: { tenantId: { $eq: TENANT_ID } },
            },
          },
        ])
        .toArray(),
    );

    expect(results).toHaveLength(1);
    expect(results[0]._id).toEqual(seededChunkId);
  });

  it('should not find the seeded chunk via $vectorSearch when pre-filtered to a different tenantId', async () => {
    const results = await db
      .collection<EvidenceChunkTestDoc>(COLLECTION)
      .aggregate<EvidenceChunkTestDoc>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: 'embedding',
            queryVector: embedding,
            numCandidates: 10,
            limit: 1,
            filter: { tenantId: { $eq: `${TENANT_ID}-other` } },
          },
        },
      ])
      .toArray();

    expect(results).toHaveLength(0);
  });
});
