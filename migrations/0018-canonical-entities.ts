import type { Db } from 'mongodb';

const COLLECTION = 'canonical_entities';
const TENANT_NAME_UNIQUE_INDEX = 'canonical_entities_tenantId_canonicalNameNormalized_unique';
const TENANT_ALIASES_INDEX = 'canonical_entities_tenantId_aliasesNormalized';

/**
 * `canonical_entities` is a new collection (`canonical-entity.schema.ts`), so it gets both indexes
 * from its first migration rather than growing one at a time the way older collections did. The
 * unique `{ tenantId: 1, canonicalNameNormalized: 1 }` index enforces the registry's own invariant:
 * two canonical rows for the same normalised name within one tenant is a data error, not a merge,
 * the same reasoning `0014-sources-indexes.ts`'s unique `{tenantId, name}` index documents for
 * `Source`. The non-unique `{ tenantId: 1, aliasesNormalized: 1 }` index backs
 * `CanonicalEntityService.resolve`'s alias-side lookup — non-unique because the same alias
 * appearing under two different canonical rows within a tenant is exactly the ambiguity a human
 * needs to resolve, not something this index should silently prevent.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex(
      { tenantId: 1, canonicalNameNormalized: 1 },
      { unique: true, name: TENANT_NAME_UNIQUE_INDEX },
    );
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, aliasesNormalized: 1 }, { name: TENANT_ALIASES_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TENANT_NAME_UNIQUE_INDEX);
  await db.collection(COLLECTION).dropIndex(TENANT_ALIASES_INDEX);
};
