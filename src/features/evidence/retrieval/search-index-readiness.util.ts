import { Db, ObjectId, type SearchIndexDescription } from 'mongodb';

/**
 * `$listSearchIndexes` document shape. The driver's public `ListSearchIndexesCursor` type only
 * declares `name` (see `mongodb.d.ts`), but the aggregation payload Atlas actually returns also
 * carries `status` and `queryable` — the two fields this poll needs. The cast in
 * `pollSearchIndexStatus` below is how that gap is bridged without reaching for `any`.
 */
interface SearchIndexStatusDocument {
  name: string;
  status: string;
  queryable: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Budget for the Search Index Management service to accept connections. Generous relative to the
 * few seconds it takes on a warm host, because the wait is paid once on a fresh volume and the
 * alternative to waiting is a failed deploy. */
const DEFAULT_SERVICE_TIMEOUT_MS = 120_000;
const DEFAULT_SERVICE_RETRY_INTERVAL_MS = 2_000;

/**
 * Thrown when an Atlas Search / Vector Search index never reports `READY` + `queryable` within
 * the polling budget, or reports `FAILED` outright. A caller that treats `createSearchIndex`'s
 * return as "done" hands the next reader a store that silently matches nothing until the build
 * finishes — this is the failure that makes that impossible to miss.
 */
export class SearchIndexNotReadyError extends Error {
  constructor(indexName: string, detail: string) {
    super(`Search index "${indexName}" is not queryable: ${detail}`);
    this.name = 'SearchIndexNotReadyError';
  }
}

async function pollSearchIndexStatus(
  db: Db,
  collectionName: string,
  indexName: string,
): Promise<SearchIndexStatusDocument | undefined> {
  const docs = await db.collection(collectionName).listSearchIndexes(indexName).toArray();
  // See the interface comment above: the driver under-declares this payload's shape.
  return (docs as unknown as SearchIndexStatusDocument[])[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `createSearchIndex`/`createSearchIndexes` return as soon as the build request is accepted,
 * not once the index can serve queries — Atlas builds `search`/`vectorSearch` indexes
 * asynchronously in the background. Polls `$listSearchIndexes` until the named index reports
 * both `status: 'READY'` and `queryable: true`.
 *
 * Fails fast on `status: 'FAILED'` rather than burning the full timeout budget polling a dead
 * build. Throws `SearchIndexNotReadyError` on timeout or failure — never resolves silently
 * without both conditions met.
 */
export async function waitForSearchIndexReady(
  db: Db,
  collectionName: string,
  indexName: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const doc = await pollSearchIndexStatus(db, collectionName, indexName);

    if (doc?.status === 'FAILED') {
      throw new SearchIndexNotReadyError(indexName, 'build reported status "FAILED"');
    }

    if (doc?.status === 'READY' && doc.queryable) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new SearchIndexNotReadyError(
        indexName,
        `did not become queryable within ${timeoutMs}ms (last status: ${doc?.status ?? 'not found'})`,
      );
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Thrown when the Search Index Management service never becomes reachable within the budget. The
 * message names the wait so an operator can tell a slow start from a service that is not coming up
 * at all, which are different problems with different fixes.
 */
export class SearchIndexServiceUnavailableError extends Error {
  constructor(waitedMs: number, lastMessage: string) {
    super(
      `Search Index Management service was still unreachable after ${waitedMs}ms — last error: ${lastMessage}`,
    );
    this.name = 'SearchIndexServiceUnavailableError';
  }
}

/**
 * `mongod` proxies search-index commands to `mongot`, and reports this when it cannot reach it.
 * Matched on the message because the server returns no distinguishing error code for it: every
 * variant of this condition carries the service's name, and no other failure on this path does.
 * Over-matching here would retry a genuine error for the full budget rather than failing fast, so
 * the predicate is deliberately narrow.
 */
function isSearchServiceUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Search Index Management service');
}

/**
 * Creates search indexes once the service that builds them is reachable.
 *
 * `mongod` and `mongot` start independently: a node is a writable primary, and answers every other
 * command, several seconds before `createSearchIndexes` stops failing with "Error connecting to
 * Search Index Management service". A container healthcheck cannot close that window — the cheap
 * probes for it are answered by `mongod` without ever reaching `mongot`, so they go green early, and
 * the only faithful probe is this call itself. So the operation that needs the service waits for it,
 * rather than a health signal predicting it.
 *
 * FAILURE DIRECTION — fails CLOSED. Only the unreachable-service condition is retried; every other
 * error propagates on the first attempt, and exhausting the budget throws
 * {@link SearchIndexServiceUnavailableError} rather than returning. A migration that skipped its
 * indexes and reported success would leave a store that answers every query with nothing.
 *
 * Retrying is safe because the service is unreachable *before* any index is created, so a retried
 * attempt never encounters one it made itself on a previous pass.
 */
export async function createSearchIndexesWhenReady(
  db: Db,
  collectionName: string,
  indexes: readonly SearchIndexDescription[],
  options: { timeoutMs?: number; retryIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_SERVICE_RETRY_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    try {
      await db.collection(collectionName).createSearchIndexes([...indexes]);
      return;
    } catch (error) {
      if (!isSearchServiceUnreachable(error)) {
        throw error;
      }

      if (Date.now() >= deadline) {
        throw new SearchIndexServiceUnavailableError(
          Date.now() - startedAt,
          error instanceof Error ? error.message : String(error),
        );
      }

      await sleep(retryIntervalMs);
    }
  }
}

/**
 * `true` once a known-just-written document is actually returned by the index; `false` while it
 * still isn't. `waitForIndexConvergence` treats a probe throw as a real error (not "not yet") —
 * a malformed query should fail loudly, not be indistinguishable from eventual-consistency lag.
 */
export type ConvergenceProbe = () => Promise<boolean>;

export interface IndexConvergenceOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * FAILURE DIRECTION — per caller, not global; see `waitForIndexConvergence`'s doc comment for
   * which caller gets which and why.
   *
   * - `'throw'` (default): an unconverged probe past the timeout raises `SearchIndexNotReadyError`.
   *   The unsafe-by-omission direction is deliberate — a caller that treats "converged" as a
   *   precondition for a measurement or decision must not silently get a `converged: false` it
   *   never checks.
   * - `'degrade'`: returns `{ converged: false }` instead of throwing. Opt-in only.
   */
  onTimeout?: 'throw' | 'degrade';
}

export interface IndexConvergenceResult {
  readonly converged: boolean;
}

/**
 * `waitForSearchIndexReady` closes the gap this brief opened: Atlas reports `status: 'READY'` +
 * `queryable: true` before the index has finished absorbing a just-written corpus, so a caller
 * that stops at status alone can query a technically-queryable index that still doesn't return
 * the document it was just handed. This function closes that second gap — it waits for status
 * readiness first (cheap, usually already true), then polls `probe` until it reports the
 * known-ingested document is actually returned, bounded by its own `timeoutMs` budget (separate
 * from the status-wait budget, so a slow status build doesn't eat into the convergence budget).
 *
 * The status-readiness phase always throws on `FAILED`/timeout regardless of `options.onTimeout`
 * — a build the driver itself calls broken or never-ready is not the "don't block the user"
 * case `onTimeout: 'degrade'` exists for, it is a build failure. `onTimeout` only governs what
 * happens when the index is queryable by status but the probe still hasn't converged.
 *
 * Per-caller direction (declared here, not left for the caller to guess — see
 * `IndexConvergenceOptions.onTimeout`'s doc comment):
 * - `eval/ingest-fixtures.ts` passes `'throw'` (the default): an eval run that measures retrieval
 *   quality against an unconverged corpus records a wrong number silently — recall@5 measured a
 *   minute too early versus a minute later, per the defect this function exists to close. A loud
 *   stop is strictly better than a quietly wrong metric.
 * - `IngestionService.ingestVersion` passes `'degrade'`: a user who uploads a document must not
 *   have the request hang, or the whole ingest fail, just because Atlas hasn't finished absorbing
 *   the last few chunks. The ingest itself already succeeded; a not-yet-converged index degrades
 *   to "briefly stale search results", not a broken upload.
 */
export async function waitForIndexConvergence(
  db: Db,
  collectionName: string,
  indexName: string,
  probe: ConvergenceProbe,
  options: IndexConvergenceOptions = {},
): Promise<IndexConvergenceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const onTimeout = options.onTimeout ?? 'throw';

  await waitForSearchIndexReady(db, collectionName, indexName, { timeoutMs, pollIntervalMs });

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await probe()) {
      return { converged: true };
    }

    if (Date.now() >= deadline) {
      if (onTimeout === 'throw') {
        throw new SearchIndexNotReadyError(
          indexName,
          `reported queryable but did not converge on the expected document(s) within ${timeoutMs}ms`,
        );
      }
      return { converged: false };
    }

    await sleep(pollIntervalMs);
  }
}

// Small and fixed rather than derived from the store's own candidate-pool sizing
// (`PIPELINE_CANDIDATE_MULTIPLIER`/`VECTOR_NUM_CANDIDATES_MULTIPLIER` in `mongo-hybrid.store.ts`):
// this probe only needs one specific chunk to be visible at all, not a realistic ranked pool, so
// it stays cheap to poll every `pollIntervalMs` for up to a couple of minutes.
const VECTOR_PROBE_LIMIT = 5;
const VECTOR_PROBE_NUM_CANDIDATES = 50;

/**
 * Builds a `ConvergenceProbe` for the lexical (`$search`) index: counts chunks the index actually
 * returns for `documentVersionId`, converged once that count reaches `expectedChunkCount`. Filters
 * on `documentVersionId` alone (mapped as `objectId` — see `migrations/0001-baseline.ts`)
 * rather than a specific chunk id, because the search index mapping never indexes Mongo's `_id`
 * field — there is nothing to filter a single known chunk by.
 *
 * `>=`, not `===`: a rollback race (`IngestionService.rollbackChunks`) can leave a stale chunk
 * momentarily still indexed under an old attempt token, which would make an exact-equality check
 * flap between "converged" and "not converged" for a version that already has the right chunks.
 */
export function createSearchChunkCountProbe(
  db: Db,
  collectionName: string,
  indexName: string,
  documentVersionId: string,
  expectedChunkCount: number,
): ConvergenceProbe {
  return async () => {
    const results = await db
      .collection(collectionName)
      .aggregate<{ count?: number }>([
        {
          $search: {
            index: indexName,
            compound: {
              filter: [
                { equals: { path: 'documentVersionId', value: new ObjectId(documentVersionId) } },
              ],
            },
          },
        },
        { $count: 'count' },
      ])
      .toArray();

    return (results[0]?.count ?? 0) >= expectedChunkCount;
  };
}

/**
 * Builds a `ConvergenceProbe` for the vector index: runs `$vectorSearch` with a chunk's own
 * embedding (self-similarity is ~1.0 cosine, so it is reliably its own nearest neighbour) and
 * checks that chunk's id comes back. Only `tenantId` is declared a `filter` field on the vector
 * index (see the migration), so — unlike the search probe — this cannot filter by
 * `documentVersionId`; a single known chunk id is the only handle available.
 */
export function createVectorChunkProbe(
  db: Db,
  collectionName: string,
  indexName: string,
  tenantId: string,
  knownChunkId: string,
  knownChunkEmbedding: readonly number[],
): ConvergenceProbe {
  return async () => {
    const results = await db
      .collection(collectionName)
      .aggregate<{ _id: unknown }>([
        {
          $vectorSearch: {
            index: indexName,
            path: 'embedding',
            queryVector: knownChunkEmbedding,
            numCandidates: VECTOR_PROBE_NUM_CANDIDATES,
            limit: VECTOR_PROBE_LIMIT,
            filter: { tenantId: { $eq: tenantId } },
          },
        },
        { $project: { _id: 1 } },
      ])
      .toArray();

    return results.some((doc) => doc._id === knownChunkId);
  };
}
