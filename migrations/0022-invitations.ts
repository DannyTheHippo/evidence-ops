import type { Db } from 'mongodb';

const COLLECTION = 'invitations';
const TOKEN_HASH_UNIQUE_INDEX = 'invitations_tokenHash_unique';
const TENANT_CREATED_AT_INDEX = 'invitations_tenantId_createdAt';

/**
 * `invitations` is a new collection (`invitation.schema.ts`), so it gets both indexes from its
 * first migration rather than growing one at a time. The unique `{ tokenHash: 1 }` index is the
 * redemption lookup path `InvitationsService` relies on — a duplicate hash would mean two
 * different tokens hash to the same digest, which must never be possible to insert.
 * `{ tenantId: 1, createdAt: -1 }` backs "this tenant's invitations, newest first", the same
 * tenant-leading shape `0011-tenant-leading-indexes.ts` gave five other collections.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tokenHash: 1 }, { unique: true, name: TOKEN_HASH_UNIQUE_INDEX });
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, createdAt: -1 }, { name: TENANT_CREATED_AT_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TOKEN_HASH_UNIQUE_INDEX);
  await db.collection(COLLECTION).dropIndex(TENANT_CREATED_AT_INDEX);
};
