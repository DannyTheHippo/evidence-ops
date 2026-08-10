import type { Db } from 'mongodb';

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
