import type { Db } from 'mongodb';

const COLLECTION = 'users';

/**
 * `User.tenantId`/`User.role` (added in `user.schema.ts`) need a backfill, not just a schema
 * default: Mongoose only applies `@Prop({ default })` to a document constructed fresh, never to an
 * existing document hydrated from a raw read that's missing the field (same reasoning as
 * `0004-document-version-ingestion-status.ts`). Every account created before this migration backs
 * onto the demo tenant, so backfilling to `admin` — not `member` — is the locked decision that
 * keeps those existing accounts working once the role gate lands.
 *
 * Deploy ordering: this migration must run at or before the release that starts signing `role`
 * into JWT claims. Do not rely on the schema default to cover rows already on disk — a query
 * reading a pre-migration user document would see no `role` field at all, not the Mongoose-side
 * default, because the default only applies to documents built through the model constructor.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .updateMany({ tenantId: { $exists: false } }, { $set: { tenantId: 'default' } });

  await db
    .collection(COLLECTION)
    .updateMany({ role: { $exists: false } }, { $set: { role: 'admin' } });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).updateMany({}, { $unset: { tenantId: '', role: '' } });
};
