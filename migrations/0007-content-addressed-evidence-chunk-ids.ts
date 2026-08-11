import type { Db } from 'mongodb';

const EVIDENCE_CHUNKS = 'evidence_chunks';
const EXTRACTED_FACTS = 'extracted_facts';
const CONFLICTS = 'conflicts';
const DOCUMENT_VERSIONS = 'document_versions';

/**
 * `EvidenceChunk._id` moved from a randomly minted `ObjectId` to a deterministic id derived from
 * the owning `DocumentVersion.sha256` + chunk ordinal + locator (`computeChunkId`,
 * `src/features/evidence/ingestion/compute-chunk-id.ts`) — the fix for the eval replay cache
 * (ADR-0007) never being able to hit, because the old random id made the synthesis prompt (and
 * therefore its cache key) different on every ingest run of the same bytes.
 *
 * Every existing `evidence_chunks` row was written under the old scheme and cannot be reconciled
 * with the new one without re-parsing the original bytes (there is no formula that turns an old
 * `ObjectId` into the new content-addressed id), so this drops the derived collections outright:
 * `evidence_chunks` (the identity itself), `extracted_facts` (`chunkId` refs an id that no longer
 * exists), and `conflicts` (built from `extracted_facts`). `document_versions` rows are kept —
 * their bytes are unaffected — but `ingestionStatus` is reset to `pending` (and any stale
 * `ingestionLeaseToken` cleared) so the next touch of each version re-ingests it under the new
 * scheme automatically, the same backfill direction `0004-document-version-ingestion-status.ts`
 * established for the opposite case.
 */
export const up = async (db: Db): Promise<void> => {
  await db.collection(EVIDENCE_CHUNKS).deleteMany({});
  await db.collection(EXTRACTED_FACTS).deleteMany({});
  await db.collection(CONFLICTS).deleteMany({});

  await db
    .collection(DOCUMENT_VERSIONS)
    .updateMany({}, { $set: { ingestionStatus: 'pending' }, $unset: { ingestionLeaseToken: '' } });
};

export const down = async (): Promise<void> => {
  // Irreversible: the deleted `evidence_chunks`/`extracted_facts`/`conflicts` rows carried
  // ObjectId-keyed ids this migration's `up()` cannot reconstruct — there is no data left to
  // restore them from short of re-ingesting every version's original bytes, which resetting
  // `ingestionStatus` to `pending` above already causes to happen automatically on next touch.
};
