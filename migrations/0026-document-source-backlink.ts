import { ObjectId } from 'mongodb';
import type { AnyBulkWriteOperation, Db, Document } from 'mongodb';

const DOCUMENTS_COLLECTION = 'documents';
const SOURCES_COLLECTION = 'sources';
const DOCUMENTS_SOURCE_INDEX = 'documents_tenantId_sourceId';

// Flushed to `bulkWrite` at this size, mirroring `0013-fact-group-key-normalized.ts`'s own
// reasoning — the sources cursor and the resulting document writes both stay bounded regardless
// of collection size.
const BATCH_SIZE = 500;

interface SourceFileStateProjection {
  documentId: ObjectId;
}

interface SourceProjection {
  _id: ObjectId;
  fileStates: SourceFileStateProjection[];
}

/**
 * Resolves, for every document named by at least one source's `fileStates`, which source it
 * backfills from. Sources are read sorted by `{_id: 1}` and the first source to name a given
 * `documentId` wins — a document named by two sources (the same bytes synced under two
 * connectors) deterministically attaches to the source with the lower `_id`, never to whichever
 * source the cursor happened to visit last.
 */
async function resolveDocumentSourceMap(db: Db): Promise<Map<string, ObjectId>> {
  const cursor = db
    .collection<SourceProjection>(SOURCES_COLLECTION)
    .find({}, { projection: { fileStates: 1 } })
    .sort({ _id: 1 })
    .batchSize(BATCH_SIZE);

  const documentToSource = new Map<string, ObjectId>();
  for await (const source of cursor) {
    for (const fileState of source.fileStates ?? []) {
      const documentId = fileState.documentId.toHexString();
      if (!documentToSource.has(documentId)) {
        documentToSource.set(documentId, source._id);
      }
    }
  }
  return documentToSource;
}

/**
 * `Document.sourceId` (added in `document.schema.ts`) needs a backfill, not just a schema
 * default — same reasoning as `0017-survivorship-fields.ts`'s own doc comment: Mongoose applies
 * `@Prop()` only to a document constructed fresh, never to one already on disk when the property
 * didn't exist at write time. Every document a sync pass has ever named in a `Source.fileStates`
 * entry backfills to that source (first-wins, see `resolveDocumentSourceMap`); a document a
 * browser upload created, or one no source has ever named, is left without a `sourceId` — there
 * is nothing honest to attach it to.
 *
 * Also creates the `{tenantId, sourceId}` index on `documents` (`document.schema.ts`'s own index
 * declaration carries the same key pattern, options and name).
 */
export const up = async (db: Db): Promise<void> => {
  const documentToSource = await resolveDocumentSourceMap(db);

  const documentsCollection = db.collection(DOCUMENTS_COLLECTION);
  let ops: AnyBulkWriteOperation<Document>[] = [];
  for (const [documentId, sourceId] of documentToSource) {
    ops.push({
      updateOne: {
        filter: { _id: new ObjectId(documentId), sourceId: { $exists: false } },
        update: { $set: { sourceId } },
      },
    });
    if (ops.length >= BATCH_SIZE) {
      await documentsCollection.bulkWrite(ops);
      ops = [];
    }
  }
  if (ops.length > 0) {
    await documentsCollection.bulkWrite(ops);
  }

  await documentsCollection.createIndex(
    { tenantId: 1, sourceId: 1 },
    { name: DOCUMENTS_SOURCE_INDEX },
  );
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(DOCUMENTS_COLLECTION).dropIndex(DOCUMENTS_SOURCE_INDEX);

  // Scoped to the exact `sourceId` this migration's own `up` resolved for each document, not a
  // blanket `$unset` — same reasoning as `0023-source-inventory-fields.ts`'s `down()`: a document
  // whose `sourceId` was set afterward by a real sync (once `SourcesService.syncOneFile` threads
  // it directly) must not be reverted just because it also appears in this recomputed map.
  const documentToSource = await resolveDocumentSourceMap(db);

  const documentsCollection = db.collection(DOCUMENTS_COLLECTION);
  let ops: AnyBulkWriteOperation<Document>[] = [];
  for (const [documentId, sourceId] of documentToSource) {
    ops.push({
      updateOne: {
        filter: { _id: new ObjectId(documentId), sourceId },
        update: { $unset: { sourceId: '' } },
      },
    });
    if (ops.length >= BATCH_SIZE) {
      await documentsCollection.bulkWrite(ops);
      ops = [];
    }
  }
  if (ops.length > 0) {
    await documentsCollection.bulkWrite(ops);
  }
};
