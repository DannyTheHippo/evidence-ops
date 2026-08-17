import type { Db } from 'mongodb';

const COLLECTION = 'api_keys';
const TOKEN_HASH_UNIQUE_INDEX = 'api_keys_tokenHash_unique';
const TENANT_USER_CREATED_AT_INDEX = 'api_keys_tenantId_userId_createdAt';

/**
 * `api_keys` is a new collection (`api-key.schema.ts`), so it gets both indexes from its first
 * migration rather than growing one at a time the way older collections did. The unique
 * `{ tokenHash: 1 }` index is the verification lookup path `ApiKeysService.verify` relies on — a
 * duplicate hash would mean two different tokens hash to the same digest, which must never be
 * possible to insert. `{ tenantId: 1, userId: 1, createdAt: -1 }` backs "this user's keys, newest
 * first", the same tenant-leading shape `0011-tenant-leading-indexes.ts` gave five other
 * collections, narrowed one level further to the owning user.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tokenHash: 1 }, { unique: true, name: TOKEN_HASH_UNIQUE_INDEX });
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, userId: 1, createdAt: -1 }, { name: TENANT_USER_CREATED_AT_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TOKEN_HASH_UNIQUE_INDEX);
  await db.collection(COLLECTION).dropIndex(TENANT_USER_CREATED_AT_INDEX);
};
