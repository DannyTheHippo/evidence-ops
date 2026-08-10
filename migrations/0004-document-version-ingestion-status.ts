import type { Db } from 'mongodb';

const DOCUMENT_VERSIONS = 'document_versions';
const EVIDENCE_CHUNKS = 'evidence_chunks';

/**
 * `DocumentVersion.ingestionStatus` (added to close the tracked half-ingestion gap — see
 * `IngestionService.ingestVersion`'s doc comment) needs a backfill, not just a schema default:
 * Mongoose only applies `@Prop({ default })` to a document constructed fresh, never to an
 * existing document hydrated from a raw read that's missing the field. Without this migration,
 * every version written before it would read back as `ingestionStatus: undefined`, fail the new
 * `=== 'completed'` check, and get its (already-complete) chunks deleted and re-embedded on the
 * next touch — a correctness no-op that is also a real cost bug (a full corpus re-embed).
 *
 * "Has at least one evidence chunk" is exactly the inference `ingestVersion` used to make before
 * this migration, so it stays the correct backfill rule for "was this version actually finished".
 */
export const up = async (db: Db): Promise<void> => {
  const ingestedVersionIds = await db.collection(EVIDENCE_CHUNKS).distinct('documentVersionId');

  await db
    .collection(DOCUMENT_VERSIONS)
    .updateMany({ _id: { $in: ingestedVersionIds } }, { $set: { ingestionStatus: 'completed' } });

  await db
    .collection(DOCUMENT_VERSIONS)
    .updateMany({ _id: { $nin: ingestedVersionIds } }, { $set: { ingestionStatus: 'pending' } });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(DOCUMENT_VERSIONS).updateMany({}, { $unset: { ingestionStatus: '' } });
};
