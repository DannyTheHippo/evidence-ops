import type { Db } from 'mongodb';

const COLLECTION = 'sources';
const TENANT_CREATED_AT_INDEX = 'sources_tenantId_createdAt';
const TENANT_NAME_UNIQUE_INDEX = 'sources_tenantId_name_unique';

/**
 * `sources` is a new collection (`source.schema.ts`), so it gets both indexes from its first
 * migration rather than growing one at a time the way older collections did. `{ tenantId: 1,
 * createdAt: -1 }` backs the "sources configured for tenant X, newest first" listing query, the
 * same tenant-leading shape `0011-tenant-leading-indexes.ts` gave five other collections. The
 * unique `{ tenantId: 1, name: 1 }` index is the defense-in-depth backstop for a `name` collision
 * within a tenant, mirroring how `0002-document-versions-indexes.ts` backstops `DocumentVersion`'s
 * content-addressing invariant against concurrent writers racing an application-layer check.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, createdAt: -1 }, { name: TENANT_CREATED_AT_INDEX });
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, name: 1 }, { unique: true, name: TENANT_NAME_UNIQUE_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TENANT_CREATED_AT_INDEX);
  await db.collection(COLLECTION).dropIndex(TENANT_NAME_UNIQUE_INDEX);
};
