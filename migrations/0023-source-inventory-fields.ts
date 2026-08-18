import type { Db } from 'mongodb';

const SOURCES_COLLECTION = 'sources';
const DOCUMENT_VERSIONS_COLLECTION = 'document_versions';
const INGESTION_STATUS_INDEX = 'document_versions_tenantId_ingestionStatus';

const DEFAULT_CONNECTIVITY = 'connector';
const DEFAULT_REACHABILITY = 'live';
const DEFAULT_TRACKED = true;

/**
 * `Source.connectivity`/`reachability`/`tracked` (added in `source.schema.ts`) need a backfill,
 * not just a schema default — same reasoning as `0017-survivorship-fields.ts`'s own doc comment:
 * Mongoose only applies `@Prop({ default })` to a document constructed fresh, never to one already
 * on disk when the property didn't exist at write time. Every source that predates this migration
 * backfills to the same values the schema default now applies to a freshly created row: every
 * source configured so far reached this system through a working connector, so `'connector'`/
 * `'live'` describe it accurately rather than guessing. `Source.owner` is deliberately never
 * backfilled here or anywhere — see that field's own doc comment; its absence is the gap the
 * estate's inventory pass exists to surface, and a backfill would erase that signal.
 *
 * Also creates the `{tenantId, ingestionStatus}` index on `document_versions`
 * (`document-version.schema.ts`'s own index declaration carries the same key pattern, options and
 * name) — `DocumentsService.list`'s new `ingestionStatus` filter needs it to resolve without a
 * collection scan.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(SOURCES_COLLECTION)
    .updateMany(
      { connectivity: { $exists: false } },
      { $set: { connectivity: DEFAULT_CONNECTIVITY } },
    );
  await db
    .collection(SOURCES_COLLECTION)
    .updateMany(
      { reachability: { $exists: false } },
      { $set: { reachability: DEFAULT_REACHABILITY } },
    );
  await db
    .collection(SOURCES_COLLECTION)
    .updateMany({ tracked: { $exists: false } }, { $set: { tracked: DEFAULT_TRACKED } });

  await db
    .collection(DOCUMENT_VERSIONS_COLLECTION)
    .createIndex({ tenantId: 1, ingestionStatus: 1 }, { name: INGESTION_STATUS_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  // Scoped to each field's own default value, not every row — same reasoning as
  // `0017-survivorship-fields.ts`'s `down()`: an unconditional `$unset` would also strip a value a
  // later, real edit wrote (e.g. `reachability: 'prohibited'`), and re-running `up` would then
  // backfill that row back to the default — a different, meaningful value, not a revert. Only rows
  // this migration's own `up` set are safe to undo here.
  await db
    .collection(SOURCES_COLLECTION)
    .updateMany({ connectivity: DEFAULT_CONNECTIVITY }, { $unset: { connectivity: '' } });
  await db
    .collection(SOURCES_COLLECTION)
    .updateMany({ reachability: DEFAULT_REACHABILITY }, { $unset: { reachability: '' } });
  await db
    .collection(SOURCES_COLLECTION)
    .updateMany({ tracked: DEFAULT_TRACKED }, { $unset: { tracked: '' } });

  await db.collection(DOCUMENT_VERSIONS_COLLECTION).dropIndex(INGESTION_STATUS_INDEX);
};
