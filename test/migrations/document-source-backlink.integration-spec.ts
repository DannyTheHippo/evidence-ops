import { randomUUID } from 'node:crypto';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { down, up } from '../../migrations/0026-document-source-backlink';

/**
 * Proves `migrations/0026-document-source-backlink.ts` against a real Mongo — same reasoning as
 * `ingest-document-version.pipeline.integration-spec.ts` for why this can't run as an ordinary
 * unit or e2e spec here: the sandbox blocks every socket bind, including the one
 * `mongodb-memory-server` needs to spawn a local `mongod`. Requires `docker compose up -d mongo`
 * (`CLAUDE.md` § Validation). `up`/`down` are called directly as the functions under test, never
 * through `migrate-mongo`'s changelog, and every seeded row is scoped to this spec's own
 * `tenantId`/explicit `_id`s so a shared dev container's other data is never touched.
 */
const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

const DOCUMENTS_COLLECTION = 'documents';
const SOURCES_COLLECTION = 'sources';
const DOCUMENTS_SOURCE_INDEX = 'documents_tenantId_sourceId';

const TENANT_ID = `document-source-backlink-it-${randomUUID()}`;

describe('0026-document-source-backlink (integration)', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(MONGO_DB_URI);
    await client.connect();
    db = client.db();
  });

  afterAll(async () => {
    if (db) {
      await db.collection(SOURCES_COLLECTION).deleteMany({ tenantId: TENANT_ID });
      await db.collection(DOCUMENTS_COLLECTION).deleteMany({ tenantId: TENANT_ID });
      // Best-effort: each `it` below drops this itself via `down()`, this only guards against a
      // failed assertion leaving it behind for a later run of this suite.
      await db
        .collection(DOCUMENTS_COLLECTION)
        .dropIndex(DOCUMENTS_SOURCE_INDEX)
        .catch(() => undefined);
    }
    await client?.close();
  });

  it('attaches a document named by two sources to the source with the lower _id, deterministically', async () => {
    const documentId = new ObjectId();
    // Sequential `new ObjectId()` calls carry a monotonically increasing per-process counter
    // (the bson driver's own generation guarantee), so `sourceAId` is always lower than
    // `sourceBId` regardless of wall-clock timing — the property first-wins resolution in
    // `resolveDocumentSourceMap` relies on to be deterministic rather than dependent on cursor
    // order.
    const sourceAId = new ObjectId();
    const sourceBId = new ObjectId();

    await db.collection(DOCUMENTS_COLLECTION).insertOne({
      _id: documentId,
      title: 'Named by two sources',
      sourceKind: 'pdf',
      mimeType: 'application/pdf',
      tenantId: TENANT_ID,
      sourceClass: 'unclassified',
    });
    await db.collection(SOURCES_COLLECTION).insertMany([
      {
        _id: sourceAId,
        name: 'Source A',
        kind: 'local-folder',
        path: 'a',
        enabled: true,
        fileStates: [
          { path: 'shared.pdf', sha256: 'a'.repeat(64), sizeBytes: 1, mtimeMs: 1, documentId },
        ],
        tenantId: TENANT_ID,
        connectivity: 'connector',
        reachability: 'live',
        tracked: true,
        sourceClass: 'unclassified',
      },
      {
        _id: sourceBId,
        name: 'Source B',
        kind: 'local-folder',
        path: 'b',
        enabled: true,
        fileStates: [
          { path: 'shared.pdf', sha256: 'a'.repeat(64), sizeBytes: 1, mtimeMs: 1, documentId },
        ],
        tenantId: TENANT_ID,
        connectivity: 'connector',
        reachability: 'live',
        tracked: true,
        sourceClass: 'unclassified',
      },
    ]);

    await up(db);

    const persisted = await db.collection(DOCUMENTS_COLLECTION).findOne({ _id: documentId });
    expect(persisted?.sourceId).toEqual(sourceAId);

    const indexes = await db.collection(DOCUMENTS_COLLECTION).indexes();
    const backlinkIndex = indexes.find((index) => index.name === DOCUMENTS_SOURCE_INDEX);
    expect(backlinkIndex?.key).toEqual({ tenantId: 1, sourceId: 1 });

    await down(db);

    const reverted = await db.collection(DOCUMENTS_COLLECTION).findOne({ _id: documentId });
    expect(reverted?.sourceId).toBeUndefined();
  });

  it('leaves a document no source has ever named without a sourceId', async () => {
    const documentId = new ObjectId();
    await db.collection(DOCUMENTS_COLLECTION).insertOne({
      _id: documentId,
      title: 'Browser upload, no source',
      sourceKind: 'pdf',
      mimeType: 'application/pdf',
      tenantId: TENANT_ID,
      sourceClass: 'unclassified',
    });

    await up(db);

    const persisted = await db.collection(DOCUMENTS_COLLECTION).findOne({ _id: documentId });
    expect(persisted?.sourceId).toBeUndefined();

    await down(db);
  });
});
