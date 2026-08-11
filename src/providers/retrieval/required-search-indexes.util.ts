import { mongo } from 'mongoose';
import {
  RequiredSearchIndexesMissingError,
  type MissingSearchIndexProblem,
} from './errors/required-search-indexes-missing.error';
import { COLLECTION, SEARCH_INDEX, VECTOR_INDEX } from './retrieval.constant';

const REQUIRED_INDEXES: readonly string[] = [SEARCH_INDEX, VECTOR_INDEX];

/**
 * `$listSearchIndexes` document shape — same under-declared payload `search-index-readiness.util`
 * documents on its own copy of this interface; not imported from there, `src/providers/**` never
 * imports `src/features/**` (see `mongo-hybrid.store.ts` and its neighbours — the provider layer
 * sits below features, not beside it).
 */
interface ListedSearchIndex {
  readonly name: string;
  readonly status: string;
  readonly queryable: boolean;
}

/**
 * Closes the gap `assertAtlasSearchSupported` (`./atlas-search-capability.util`) deliberately
 * leaves open: that probe only establishes the server *can* speak Atlas Search at all
 * (`listSearchIndexes` doesn't reject), never that the two indexes this store actually queries —
 * `evidence_chunks_search`/`evidence_chunks_vector` (`./retrieval.constant`) — exist and are
 * queryable. A server can answer `listSearchIndexes` with an empty list (indexes dropped, or a
 * `/data/mongot` volume recreated without them) and still pass that check.
 *
 * Callers must run `assertAtlasSearchSupported` first (both current callers already do — see
 * `MongoHybridRetrievalStore.ensureSearchCapability` and `eval/run.ts`) — this function assumes
 * `listSearchIndexes` is a command the server accepts, and does not itself distinguish "command
 * rejected" from "command answered, list is empty."
 *
 * Fails CLOSED: an index that is missing or reports anything short of `status: 'READY'` +
 * `queryable: true` must stop the caller before it runs `$search`/`$vectorSearch`/`$rankFusion`
 * against it. Unlike `waitForIndexConvergence`'s per-caller `onTimeout: 'degrade'` option
 * (`search-index-readiness.util.ts`) — which exists because a not-yet-converged index during
 * ingest is transient and self-healing on its own within seconds — a missing or dead index here
 * is a persistent misconfiguration that does not resolve itself. Degrading (letting the query run
 * anyway) would reproduce, in code, the exact silent failure this function exists to close:
 * `$rankFusion` over a nonexistent index returns zero rows, indistinguishable from "no documents
 * matched," which is precisely how the eval corpus went to 0.00 recall with no error anywhere.
 * There is no caller for which that trade is worth making, so this throws unconditionally rather
 * than taking an `onTimeout`-style option.
 */
export async function assertRequiredSearchIndexesExist(db: mongo.Db): Promise<void> {
  const listed = (await db
    .collection(COLLECTION)
    .listSearchIndexes()
    .toArray()) as unknown as ListedSearchIndex[];
  const byName = new Map(listed.map((index) => [index.name, index]));

  const problems: MissingSearchIndexProblem[] = REQUIRED_INDEXES.flatMap(
    (name): MissingSearchIndexProblem[] => {
      const found = byName.get(name);
      if (!found) {
        return [{ name, kind: 'missing', detail: 'not found' }];
      }
      if (found.status !== 'READY' || !found.queryable) {
        return [
          {
            name,
            kind: 'not-queryable',
            detail: `status "${found.status}", queryable=${String(found.queryable)}`,
          },
        ];
      }
      return [];
    },
  );

  if (problems.length > 0) {
    throw new RequiredSearchIndexesMissingError(problems);
  }
}
