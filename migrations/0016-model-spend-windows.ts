import type { Db } from 'mongodb';

const COLLECTION = 'model_spend_windows';
const TENANT_WINDOW_INDEX = 'model_spend_windows_tenantId_windowStart_unique';
const TTL_INDEX = 'model_spend_windows_createdAt_ttl';

/** 30 days: `TenantSpendService` only ever reads or writes the current day's window, so this
 * retention exists purely to bound the collection's size against forever-accumulating rows — 30
 * days comfortably outlives a single daily window while still leaving a month of spend history
 * available for the tenant an operator is debugging a budget complaint for. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * `TenantSpendService.reserve` upserts a window doc keyed by `(tenantId, windowStart)` and then
 * conditionally increments it; the unique index is what makes that key collision-free under
 * concurrent first-call upserts for the same tenant and day. The TTL index expires rows off
 * `createdAt` (stamped by the schema's `timestamps: true`), not `windowStart`, so a window created
 * near the end of one day and touched again early the next still expires on a fixed clock rather
 * than resetting every time it is read.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, windowStart: 1 }, { name: TENANT_WINDOW_INDEX, unique: true });

  await db
    .collection(COLLECTION)
    .createIndex({ createdAt: 1 }, { name: TTL_INDEX, expireAfterSeconds: TTL_SECONDS });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TTL_INDEX);
  await db.collection(COLLECTION).dropIndex(TENANT_WINDOW_INDEX);
};
