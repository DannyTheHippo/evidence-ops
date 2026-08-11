import type { Db } from 'mongodb';

const EVIDENCE_CHUNKS = 'evidence_chunks';
const EXTRACTED_FACTS = 'extracted_facts';
const CONFLICTS = 'conflicts';
const DOCUMENT_VERSIONS = 'document_versions';

/**
 * `computeChunkId` (`src/features/evidence/ingestion/compute-chunk-id.ts`) now folds `tenantId`
 * into `EvidenceChunk._id`, not just `documentVersionSha256 + ordinal + locator`. The unscoped
 * derivation `0007-content-addressed-evidence-chunk-ids.ts` shipped let two tenants that happened
 * to ingest byte-identical content collide on the same `_id` — the second tenant's `insertMany`
 * either failed with `E11000 duplicate key error` or, worse, would have silently reused the first
 * tenant's row, because `IngestionService`'s own cleanup deletes by `documentVersionId` and never
 * clears a colliding row it does not own. Every row written under the old, unscoped scheme carries
 * an id this migration cannot reconcile with the new tenant-scoped one (there is no formula that
 * derives a tenant-scoped id from the old id without the original bytes), so — following exactly
 * the precedent `0007` itself set for the same reason — this drops the derived collections
 * outright: `evidence_chunks` (the identity itself), `extracted_facts` (`chunkId` refs an id that
 * no longer exists), and `conflicts` (built from `extracted_facts`). `document_versions` rows are
 * kept — their bytes are unaffected — but `ingestionStatus` is reset to `pending` (and any stale
 * `ingestionLeaseToken` cleared) so the next touch of each version re-ingests it under the new
 * scheme automatically.
 *
 * This invalidates the eval replay cache (`eval/cache/`) a second time, for the same reason `0007`
 * did: every chunk id changes, so every recorded prompt that embeds a `chunkId` in its evidence
 * fence changes too, and a replay against the old cache would miss on every case. Re-recording
 * (`npm run eval -- --record`) is required after this migration runs, same as after `0007`.
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
  // unscoped-id-keyed data this migration's `up()` cannot reconstruct — there is no data left to
  // restore them from short of re-ingesting every version's original bytes, which resetting
  // `ingestionStatus` to `pending` above already causes to happen automatically on next touch.
};
