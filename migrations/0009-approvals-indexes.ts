import type { Db } from 'mongodb';

const COLLECTION = 'approvals';
const PENDING_INBOX_INDEX = 'approvals_tenantId_state_createdAt';

/**
 * Backs the pending-inbox query the D3 HTTP API will need at minimum: "every pending approval
 * for tenant X, oldest/newest first". `tenantId` leads because every real query scopes by tenant
 * first (same reasoning as `extracted_facts_documentVersionId` in
 * `0005-extracted-facts-indexes.ts`, applied to this collection's own leading filter). No
 * `subject.entityId` index yet — `mongoose.md` says verify an access pattern before indexing on
 * a guess, and D2/D3 (which would define that lookup) are not built.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, state: 1, createdAt: 1 }, { name: PENDING_INBOX_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(PENDING_INBOX_INDEX);
};
