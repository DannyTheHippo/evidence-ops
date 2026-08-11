import { mongo } from 'mongoose';
import { AtlasSearchUnavailableError } from './errors/atlas-search-unavailable.error';
import { COLLECTION } from './retrieval.constant';

/**
 * Probes whether the connected Mongo server is actually backed by `mongot` (Atlas Search),
 * called by `MongoHybridRetrievalStore` (memoized per instance, see that class) and by
 * `eval/run.ts` (as an unmemoized preflight, before any embedding/model spend). Both callers
 * throw `AtlasSearchUnavailableError` on failure, never a raw driver error.
 *
 * A version check is not sufficient: community MongoDB 8.1+ ships `$rankFusion` syntax without
 * ever having `mongot` behind it, so a server can parse the stage and still have no index to
 * fuse over. `listSearchIndexes` is mongot-only — a plain server rejects the command outright —
 * so it is the one probe that actually establishes Atlas Search presence rather than merely
 * "recent enough syntax." Cheap: it reads `evidence_chunks`' index metadata, not its documents.
 */
export async function assertAtlasSearchSupported(db: mongo.Db): Promise<void> {
  try {
    await db.collection(COLLECTION).listSearchIndexes().toArray();
  } catch (cause) {
    // Fails CLOSED: an unverifiable capability (index build, auth failure, or genuinely no
    // mongot — this probe cannot tell those apart, see the error's own doc comment) must not
    // let a paid ingest or a live query proceed against a server that may not support the
    // stages the rest of this store depends on.
    throw new AtlasSearchUnavailableError(cause);
  }
}
