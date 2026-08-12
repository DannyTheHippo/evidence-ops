import type { Db } from 'mongodb';

const EVIDENCE_CHUNKS_COLLECTION = 'evidence_chunks';
const EVIDENCE_CHUNKS_INDEX = 'evidence_chunks_tenantId_documentVersionId';

/**
 * `GET /documents/versions/:versionId/chunks` (S5) queries `evidence_chunks` by `{ tenantId,
 * documentVersionId }` — the same tenant-leading shape `0011` gave five other collections, but
 * `evidence_chunks` was not among them because nothing read it by version until now. `0006` and
 * `0008` only cover `{ tenantId, chunkId }`-scoped access from the grounding check and the
 * tenant-scoped id rework, not this one.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(EVIDENCE_CHUNKS_COLLECTION)
    .createIndex({ tenantId: 1, documentVersionId: 1 }, { name: EVIDENCE_CHUNKS_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(EVIDENCE_CHUNKS_COLLECTION).dropIndex(EVIDENCE_CHUNKS_INDEX);
};
