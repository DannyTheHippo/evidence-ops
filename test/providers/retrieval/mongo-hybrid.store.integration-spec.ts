import { randomUUID } from 'node:crypto';
import { Db, MongoClient, ObjectId } from 'mongodb';
import type { Connection } from 'mongoose';
import {
  COLLECTION,
  SEARCH_INDEX,
  VECTOR_INDEX,
  resolveVectorDimensions,
} from '../../../migrations/0003-search-indexes';
import { waitForSearchIndexReady } from '../../../src/features/evidence/retrieval/search-index-readiness.util';
import type { EvidenceLocator } from '../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { FakeEmbeddingProvider } from '../../../src/providers/embedding/fake-embedding.provider';
import {
  MongoHybridRetrievalStore,
  type HybridRetrievalHitMetadata,
} from '../../../src/providers/retrieval/mongo-hybrid.store';
import type { RetrievalHit } from '../../../src/providers/retrieval/retrieval-store.interface';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

/**
 * Proves `MongoHybridRetrievalStore` against a real `mongodb/mongodb-atlas-local` container —
 * neither `$rankFusion` nor `$vectorSearch` is servable by `mongodb-memory-server` (used by
 * `mongo-hybrid.store.spec.ts`'s mocked-aggregate unit tests). Requires `docker compose up -d
 * mongo` and `npm run migrate:up` to have already run (`CLAUDE.md` § Validation), same
 * precondition as `search-indexes.integration-spec.ts`.
 *
 * Reads `MONGO_DB_URI` directly and builds a native `MongoClient`, mirroring
 * `search-indexes.integration-spec.ts` rather than standing up a full Mongoose `Connection`:
 * `MongoHybridRetrievalStore`'s constructor only ever touches `connection.db` (same invariant as
 * `GridFsDocumentStore`), so a hand-built `{ db }` satisfies it without the extra machinery.
 */
const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

const READINESS_TIMEOUT_MS = 15_000;
const TENANT_ID = `hybrid-retrieval-it-${randomUUID()}`;
const OTHER_TENANT_ID = `${TENANT_ID}-other`;
const MARKER = `hybrid-retrieval-marker-${randomUUID()}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Same rationale as `search-indexes.integration-spec.ts`'s `retryUntilFound`: `$search`/
 * `$vectorSearch` indexing is eventually consistent, so a query immediately after an insert is a
 * flake factory. Unlike that spec's helper, this one can't stop at "any hit" — the distractor
 * chunk shares the seeded chunk's tenant and can itself surface early (it passes the tenant
 * filter, and the standard analyzer splits the `MARKER` token on hyphens, so a weak lexical match
 * against the distractor's text is possible). Retries until the *target* id specifically appears,
 * returning whatever came back at the deadline either way so a genuine failure's message shows
 * what the store actually returned.
 */
async function retryUntilFound(
  run: () => Promise<RetrievalHit<HybridRetrievalHitMetadata>[]>,
  targetId: string,
  { timeoutMs = 20_000, intervalMs = 500 } = {},
): Promise<RetrievalHit<HybridRetrievalHitMetadata>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const results = await run();
    if (results.some((hit) => hit.id === targetId) || Date.now() >= deadline) {
      return results;
    }
    await sleep(intervalMs);
  }
}

/** Deterministic, seed-dependent vector — the vector-search assertions query with the exact
 *  vector a seeded chunk was stored with, so that chunk is guaranteed its own nearest neighbour
 *  regardless of magnitude (mirrors `search-indexes.integration-spec.ts`'s `buildSeedEmbedding`).
 *  `seed` only needs to make the two fixture vectors distinct, not orthogonal. */
function buildEmbedding(dimensions: number, seed: number): number[] {
  return Array.from({ length: dimensions }, (_, i) => ((i + seed) % 11) / 11);
}

interface EvidenceChunkTestDoc {
  _id?: ObjectId;
  documentId: ObjectId;
  documentVersionId: ObjectId;
  text: string;
  tokenCount: number;
  embedding: number[];
  locator: EvidenceLocator;
  tenantId: string;
}

describe('MongoHybridRetrievalStore (integration)', () => {
  let client: MongoClient;
  let db: Db;
  let connection: Connection;
  let seededChunkId: ObjectId;
  let distractorChunkId: ObjectId;
  let seedEmbedding: number[];

  beforeAll(async () => {
    client = new MongoClient(MONGO_DB_URI);
    await client.connect();
    db = client.db();
    connection = { db } as unknown as Connection;

    const dimensions = resolveVectorDimensions();
    seedEmbedding = buildEmbedding(dimensions, 0);
    const distractorEmbedding = buildEmbedding(dimensions, 5);

    await waitForSearchIndexReady(db, COLLECTION, SEARCH_INDEX, {
      timeoutMs: READINESS_TIMEOUT_MS,
    });
    await waitForSearchIndexReady(db, COLLECTION, VECTOR_INDEX, {
      timeoutMs: READINESS_TIMEOUT_MS,
    });

    const collection = db.collection<EvidenceChunkTestDoc>(COLLECTION);

    const seedResult = await collection.insertOne({
      documentId: new ObjectId(),
      documentVersionId: new ObjectId(),
      text: `Cap rate summary for the comps spreadsheet region ${MARKER}: the portfolio traded at a 5.60% average cap rate this quarter.`,
      tokenCount: 20,
      embedding: seedEmbedding,
      locator: {
        kind: 'xlsx-region',
        sheetName: 'Comps',
        range: 'A1:H11',
        extractorVersion: 'hybrid-retrieval-it',
      },
      tenantId: TENANT_ID,
    });
    seededChunkId = seedResult.insertedId;

    const distractorResult = await collection.insertOne({
      documentId: new ObjectId(),
      documentVersionId: new ObjectId(),
      text: `Industrial vacancy commentary unrelated to the seeded marker ${randomUUID()}.`,
      tokenCount: 12,
      embedding: distractorEmbedding,
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'hybrid-retrieval-it' },
      tenantId: TENANT_ID,
    });
    distractorChunkId = distractorResult.insertedId;
  });

  afterAll(async () => {
    if (db) {
      await db
        .collection<EvidenceChunkTestDoc>(COLLECTION)
        .deleteMany({ _id: { $in: [seededChunkId, distractorChunkId].filter(Boolean) } });
    }
    await client?.close();
  });

  const buildStore = (fusion: 'server' | 'app'): MongoHybridRetrievalStore =>
    new MongoHybridRetrievalStore(
      connection,
      new FakeEmbeddingProvider(),
      getMockTypedConfig({ retrieval: { fusion, limit: 12, strategy: 'single-shot' } }),
    );

  // The query already carries `vector: seedEmbedding` (the exact vector the seeded chunk was
  // stored with), so `search()` never calls the embedding provider — no live Voyage API key is
  // needed for this suite to be meaningful.
  const buildQuery = (tenantId: string) => ({
    text: `cap rate ${MARKER}`,
    vector: seedEmbedding,
    limit: 5,
    filter: { tenantId },
  });

  it.each(['server', 'app'] as const)(
    'should return the comps spreadsheet region chunk in the top-k in %s fusion mode',
    async (fusion) => {
      const store = buildStore(fusion);

      const hits = await retryUntilFound(
        () => store.search(buildQuery(TENANT_ID)),
        seededChunkId.toString(),
      );

      const hit = hits.find((h) => h.id === seededChunkId.toString());
      expect(hit).toBeDefined();
      expect(hit?.metadata.locator).toMatchObject({ kind: 'xlsx-region', sheetName: 'Comps' });
      expect(hit?.metadata.documentId).toBeDefined();
      expect(hit?.metadata.tenantId).toBe(TENANT_ID);
      // Explainability breakdown should be populated in both modes, not just the server one.
      expect(hit?.metadata.scoreBreakdown.length).toBeGreaterThan(0);
      expect(hit?.metadata.scoreBreakdown.some((entry) => entry.rank !== null)).toBe(true);
    },
  );

  it.each(['server', 'app'] as const)(
    'should return nothing for the same query under a different tenant in %s fusion mode',
    async (fusion) => {
      const store = buildStore(fusion);

      const hits = await store.search(buildQuery(OTHER_TENANT_ID));

      expect(hits).toHaveLength(0);
    },
  );
});
