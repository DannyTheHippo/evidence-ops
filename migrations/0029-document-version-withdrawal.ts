import type { Db } from 'mongodb';

const COLLECTION = 'document_versions';
const INDEX = 'document_versions_tenantId_withdrawnAt';

/**
 * `DocumentVersion.withdrawnAt`/`withdrawnReason` (added in `document-version.schema.ts`) back
 * `SourcesService.runSync`'s soft-withdrawal path. No backfill: unlike `0023-source-inventory-
 * fields.ts` and `0017-survivorship-fields.ts`, absence of `withdrawnAt` on a pre-existing row
 * genuinely means "never withdrawn" — there is no prior behaviour this field is retroactively
 * describing, only future sync sweeps ever set it.
 *
 * Partial index, same key pattern, options and name as `document-version.schema.ts`'s own
 * declaration — see that file's comment for why the migration and the schema both carry it.
 */
export const up = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).createIndex(
    { tenantId: 1, withdrawnAt: 1 },
    {
      name: INDEX,
      partialFilterExpression: { withdrawnAt: { $exists: true } },
    },
  );
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(INDEX);
};
