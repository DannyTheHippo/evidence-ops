import type { Db } from 'mongodb';

const COLLECTION = 'document_versions';
const SHA256_INDEX = 'document_versions_documentId_sha256_unique';
const VERSION_NUMBER_INDEX = 'document_versions_documentId_versionNumber_unique';

/**
 * `document-version.schema.ts` calls out that its content-addressing invariant — one version per
 * (document, sha256) — is "indexed uniquely per document" here, not via a `@Prop({ index: true })`
 * (`rules/mongoose.md`). `DocumentsService` already enforces this at the application layer before
 * a write; this index is the defense-in-depth backstop for concurrent writers racing that check.
 * A second unique index on (document, versionNumber) prevents a similar race from handing two
 * concurrent uploads the same version number.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ documentId: 1, sha256: 1 }, { unique: true, name: SHA256_INDEX });
  await db
    .collection(COLLECTION)
    .createIndex({ documentId: 1, versionNumber: 1 }, { unique: true, name: VERSION_NUMBER_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(SHA256_INDEX);
  await db.collection(COLLECTION).dropIndex(VERSION_NUMBER_INDEX);
};
