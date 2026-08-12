import type { AnyBulkWriteOperation, Db, Document, ObjectId } from 'mongodb';

const EXTRACTED_FACTS_COLLECTION = 'extracted_facts';
const CONFLICTS_COLLECTION = 'conflicts';

const EXTRACTED_FACTS_INDEX = 'extracted_facts_tenantId_groupKeyNormalized';
const CONFLICTS_TENANT_STATUS_GROUP_INDEX = 'conflicts_tenantId_status_groupKeyNormalized';

// Flushed to `bulkWrite` at this size so neither collection is ever held in Node memory as one
// array nor updated via a single unbounded server-side operation over the whole collection.
const BATCH_SIZE = 500;

interface BackfillFactKey {
  entity: string;
  metric: string;
  period: string;
}

/**
 * Mirrors `groupKey` in `src/features/evidence/conflicts/detect-conflicts.ts` exactly — same
 * trimmed+lowercased `entity`, exact `metric`/`period`, same `::`-joined shape — because
 * `ConflictsService.scanForConflicts`'s incremental path groups on this field to find the same
 * conflict groups the live grouping code would find. Inlined rather than imported: migrations are
 * immutable applied snapshots (`mongoose.md` — "FORBIDDEN to edit a migration that has already
 * been applied"), so importing the live function would make an already-applied migration's
 * behavior change retroactively the next time `groupKey` itself is edited. If `groupKey` ever
 * changes, a later migration re-backfills — this one stays a frozen snapshot of what it computed
 * the day it ran.
 */
function computeGroupKeyNormalized(factKey: BackfillFactKey): string {
  return `${factKey.entity.trim().toLowerCase()}::${factKey.metric}::${factKey.period}`;
}

/**
 * Cursor-batched, not `updateMany({}, [...])`: `groupKeyNormalized` depends on a per-document
 * computation (trim + lowercase `entity`) that isn't expressible as a plain `$set` value, and an
 * aggregation-pipeline update would still process the entire collection in one unbounded
 * server-side operation. Reading `BATCH_SIZE` documents at a time via `batchSize` and flushing one
 * `bulkWrite` per batch keeps both peak memory and the size of any single write bounded, for a
 * collection of any size.
 */
async function backfillGroupKeyNormalized(db: Db, collectionName: string): Promise<void> {
  const collection = db.collection(collectionName);
  const cursor = collection
    .find<{ _id: ObjectId; factKey: BackfillFactKey }>({}, { projection: { factKey: 1 } })
    .batchSize(BATCH_SIZE);

  let ops: AnyBulkWriteOperation<Document>[] = [];
  for await (const doc of cursor) {
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { groupKeyNormalized: computeGroupKeyNormalized(doc.factKey) } },
      },
    });
    if (ops.length >= BATCH_SIZE) {
      await collection.bulkWrite(ops);
      ops = [];
    }
  }
  if (ops.length > 0) {
    await collection.bulkWrite(ops);
  }
}

/**
 * `ExtractedFact.groupKeyNormalized`/`Conflict.groupKeyNormalized` (both schemas' own doc
 * comments) denormalize `groupKey`'s case-insensitive grouping key at write time — no MongoDB
 * collation index can serve that case-insensitive grouping directly, so the field itself has to
 * exist on the document for an index to key on it. Both new write sites
 * (`FactsService.extractFacts`, `ConflictsService.scanForConflicts`'s insert) set it going
 * forward; this migration backfills every document written before this change and creates the
 * two indexes `ConflictsService.scanForConflicts`'s incremental path needs: `extracted_facts` by
 * `{tenantId, groupKeyNormalized}` (the fact query, scoped to the touched groups) and `conflicts`
 * by `{tenantId, status, groupKeyNormalized}` (the open-conflict idempotency check, which always
 * filters on `status: 'open'` too).
 */
export const up = async (db: Db): Promise<void> => {
  await backfillGroupKeyNormalized(db, EXTRACTED_FACTS_COLLECTION);
  await backfillGroupKeyNormalized(db, CONFLICTS_COLLECTION);

  await db
    .collection(EXTRACTED_FACTS_COLLECTION)
    .createIndex({ tenantId: 1, groupKeyNormalized: 1 }, { name: EXTRACTED_FACTS_INDEX });
  await db
    .collection(CONFLICTS_COLLECTION)
    .createIndex(
      { tenantId: 1, status: 1, groupKeyNormalized: 1 },
      { name: CONFLICTS_TENANT_STATUS_GROUP_INDEX },
    );
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(EXTRACTED_FACTS_COLLECTION).dropIndex(EXTRACTED_FACTS_INDEX);
  await db.collection(CONFLICTS_COLLECTION).dropIndex(CONFLICTS_TENANT_STATUS_GROUP_INDEX);

  // Blanket `updateMany` unset, not a second cursor-batched loop: unlike the compute-per-document
  // backfill above, `$unset` needs no per-document computation, matching `0004`'s own `down()`
  // precedent for the same shape of field removal.
  await db
    .collection(EXTRACTED_FACTS_COLLECTION)
    .updateMany({}, { $unset: { groupKeyNormalized: '' } });
  await db.collection(CONFLICTS_COLLECTION).updateMany({}, { $unset: { groupKeyNormalized: '' } });
};
