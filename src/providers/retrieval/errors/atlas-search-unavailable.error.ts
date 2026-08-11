/**
 * Not a `BaseException`/`HttpException` — same reasoning as `ModelBudgetExceededError`: the
 * provider layer runs outside HTTP request scope (a Temporal activity via
 * `EvidenceRetrievalService`, or `eval/run.ts`'s preflight check), so it cannot assume a
 * controller is there to catch it. Callers that do sit behind a controller are responsible for
 * mapping this to an HTTP response themselves.
 *
 * Thrown by `assertAtlasSearchSupported` (`./atlas-search-capability.util`) when
 * `listSearchIndexes` rejects — the exact failure mode that cost two full eval runs' worth of
 * Anthropic/Voyage spend before this check existed: `MONGO_DB_URI` pointed at a plain `mongo:7`
 * server, and the first sign of it was a raw `MongoServerError: Unrecognized pipeline stage
 * name: '$rankFusion'` deep inside a search call, after the corpus was already ingested.
 */
export class AtlasSearchUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'The connected Mongo server does not support Atlas Search stages ($search / ' +
        '$vectorSearch / $rankFusion), or support could not be verified (listSearchIndexes ' +
        'failed — see "cause" for the underlying error). This almost always means MONGO_DB_URI ' +
        'points at a plain MongoDB server instead of mongodb/mongodb-atlas-local. Note ' +
        'RETRIEVAL_FUSION=app is NOT a workaround for a plain server: app-side fusion still ' +
        'runs $search and $vectorSearch directly, both of which require the same ' +
        'mongot-backed server.',
      { cause },
    );
    this.name = 'AtlasSearchUnavailableError';
  }
}
