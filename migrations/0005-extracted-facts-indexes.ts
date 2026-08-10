import type { Db } from 'mongodb';

const COLLECTION = 'extracted_facts';
const DOCUMENT_VERSION_INDEX = 'extracted_facts_documentVersionId';

/**
 * `ExtractedFact.documentVersionId` (added alongside `FactsService.extractFacts`, which had never
 * actually been wired to run — see `extracted-fact.schema.ts`'s doc comment) is queried by
 * `extractFacts`'s idempotency check and by its partial-insert rollback on every call, so it needs
 * an index for the same reason `document_versions_documentId_sha256_unique` does. No backfill is
 * needed, unlike `0004-document-version-ingestion-status.ts`: this collection has no existing
 * documents to backfill — nothing has ever written to it in production.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ documentVersionId: 1 }, { name: DOCUMENT_VERSION_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(DOCUMENT_VERSION_INDEX);
};
