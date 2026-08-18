import type { Db } from 'mongodb';

const COLLECTION = 'api_keys';
const TENANT_USER_REVOKED_AT_INDEX = 'api_keys_tenantId_userId_revokedAt';

/**
 * `ApiKeysService.mint` now counts a user's active (non-revoked, unexpired) keys against a cap on
 * every mint call — a query that previously had no purpose and no index. `{ tenantId: 1, userId: 1,
 * revokedAt: 1 }` lets that count resolve against the same tenant/user prefix
 * `api_keys_tenantId_userId_createdAt` already narrows, with `revokedAt` added so Mongo can skip
 * revoked rows at the index level rather than filtering them out afterwards. Declared here and in
 * `api-key.schema.ts` with the same key pattern, options and name — `lastUsedAt` and the
 * default-expiry behaviour need no schema change of their own (`expiresAt` already exists; a
 * pre-migration key with no `expiresAt` never expires, and that stays true for it going forward).
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, userId: 1, revokedAt: 1 }, { name: TENANT_USER_REVOKED_AT_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TENANT_USER_REVOKED_AT_INDEX);
};
