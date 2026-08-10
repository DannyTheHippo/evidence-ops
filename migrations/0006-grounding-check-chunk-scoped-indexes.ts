import type { Db } from 'mongodb';

const EXTRACTED_FACTS_COLLECTION = 'extracted_facts';
const EXTRACTED_FACTS_INDEX = 'extracted_facts_tenantId_chunkId';

const CONFLICTS_COLLECTION = 'conflicts';
const CONFLICTS_INDEX = 'conflicts_tenantId_status_factIds';

/**
 * `src/worker/activities.ts`'s `groundingCheck` now queries both collections scoped to a
 * request's retrieved chunk ids (`FactsService.findCellFacts`,
 * `ConflictsService.findConflictedFactGroupsForChunks` — see their own doc comments for why that
 * scoping, not the tenant's whole collection, is load-bearing) on every `answered` outcome, so
 * both queries need a supporting index the same way `0005-extracted-facts-indexes.ts` added one
 * for `extractFacts`'s idempotency check.
 *
 * `extracted_facts_tenantId_chunkId` covers both `findCellFacts` (`{ chunkId: { $in }, tenantId,
 * 'locator.kind': 'xlsx-cell' }`) and the touched-facts lookup inside
 * `findConflictedFactGroupsForChunks` (`{ chunkId: { $in }, tenantId }`) — `tenantId` first since
 * it is always an equality match and `chunkId` is the `$in`, the usual compound-index ordering
 * for that shape. `locator.kind` isn't part of the index: the chunk-id-scoped candidate set is
 * already small (`RETRIEVAL_LIMIT` in `evidence-retrieval.service.ts` caps a request's retrieved
 * chunks at 12), so a second equality field would add index-maintenance cost without a
 * measurable scan-time win.
 *
 * `conflicts_tenantId_status_factIds` covers `findConflictedFactGroupsForChunks`'s conflict
 * lookup (`{ tenantId, status: 'open', factIds: { $in } }`) — `factIds` is a multikey array, so
 * it goes last in the compound index per Mongo's single-multikey-field-per-compound-index rule,
 * after the two equality fields.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(EXTRACTED_FACTS_COLLECTION)
    .createIndex({ tenantId: 1, chunkId: 1 }, { name: EXTRACTED_FACTS_INDEX });
  await db
    .collection(CONFLICTS_COLLECTION)
    .createIndex({ tenantId: 1, status: 1, factIds: 1 }, { name: CONFLICTS_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(EXTRACTED_FACTS_COLLECTION).dropIndex(EXTRACTED_FACTS_INDEX);
  await db.collection(CONFLICTS_COLLECTION).dropIndex(CONFLICTS_INDEX);
};
