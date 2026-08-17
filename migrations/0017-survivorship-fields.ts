import type { Db } from 'mongodb';

const DOCUMENTS_COLLECTION = 'documents';
const SOURCES_COLLECTION = 'sources';
const UNCLASSIFIED = 'unclassified';

/**
 * `Document.sourceClass`/`Source.sourceClass` (added in `document.schema.ts`/`source.schema.ts`)
 * need a backfill, not just a schema default — same reasoning as `0010-user-tenancy-and-roles.ts`'s
 * own doc comment: Mongoose only applies `@Prop({ default })` to a document constructed fresh,
 * never to one already on disk when the property didn't exist at write time. Every document and
 * source that predates this migration backfills to `'unclassified'`, the same value the schema
 * default now applies to a freshly created row — this migration exists only to make that value
 * visible to a query against rows the default never touched.
 *
 * `ExtractedFact.observedAt` is deliberately not backfilled here or anywhere: absence is meaningful
 * (see that field's own doc comment) and a backfill would fabricate an observation date for
 * evidence that never carried one.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(DOCUMENTS_COLLECTION)
    .updateMany({ sourceClass: { $exists: false } }, { $set: { sourceClass: UNCLASSIFIED } });

  await db
    .collection(SOURCES_COLLECTION)
    .updateMany({ sourceClass: { $exists: false } }, { $set: { sourceClass: UNCLASSIFIED } });
};

export const down = async (db: Db): Promise<void> => {
  // Scoped to `sourceClass: UNCLASSIFIED`, not every row: an unconditional `$unset` would also
  // strip a value written after this migration ran (e.g. `pm-export`, classified by later
  // ingestion), and re-running `up` would then backfill that row to `'unclassified'` — a
  // different, meaningful value, not a revert. Only rows this migration's own `up` set are safe
  // to undo here.
  await db
    .collection(DOCUMENTS_COLLECTION)
    .updateMany({ sourceClass: UNCLASSIFIED }, { $unset: { sourceClass: '' } });
  await db
    .collection(SOURCES_COLLECTION)
    .updateMany({ sourceClass: UNCLASSIFIED }, { $unset: { sourceClass: '' } });
};
