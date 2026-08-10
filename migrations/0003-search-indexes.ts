import type { Db, SearchIndexDescription } from 'mongodb';
import { waitForSearchIndexReady } from '../src/features/evidence/retrieval/search-index-readiness.util';

// Exported for `search-indexes.integration-spec.ts`, which asserts against the exact
// collection/index names this migration creates rather than duplicating them.
export const COLLECTION = 'evidence_chunks';
export const SEARCH_INDEX = 'evidence_chunks_search';
export const VECTOR_INDEX = 'evidence_chunks_vector';

const ALLOWED_VOYAGE_DIMENSIONS = [256, 512, 1024, 2048] as const;
const DEFAULT_VOYAGE_DIMENSIONS: (typeof ALLOWED_VOYAGE_DIMENSIONS)[number] = 1024;

function isAllowedDimension(n: number): n is (typeof ALLOWED_VOYAGE_DIMENSIONS)[number] {
  return (ALLOWED_VOYAGE_DIMENSIONS as readonly number[]).includes(n);
}

/**
 * Migrations run outside Nest's DI, so `TypedConfigService` is unavailable and
 * `environment.config.ts`'s "process.env read in exactly one file" rule (`CLAUDE.md` § Coding
 * Rules) cannot be honoured literally — this is the documented exception. Reading
 * `VOYAGE_DIMENSIONS` directly, rather than hardcoding a width, is what keeps the vector index's
 * `numDimensions` from silently drifting out of sync with the embedding model: a mismatched
 * dimension produces an index that builds successfully and then never matches anything, with no
 * error anywhere. Default and legal-value set mirror `environmentSchema`'s `VOYAGE_DIMENSIONS`
 * (`src/config/environment/environment.config.ts`) so an unset var behaves identically here and
 * in the app.
 */
export function resolveVectorDimensions(): number {
  const raw = process.env.VOYAGE_DIMENSIONS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_VOYAGE_DIMENSIONS;
  }

  const parsed = Number(raw);
  if (!isAllowedDimension(parsed)) {
    throw new Error(
      `VOYAGE_DIMENSIONS must be one of ${ALLOWED_VOYAGE_DIMENSIONS.join(', ')}, got "${raw}"`,
    );
  }

  return parsed;
}

/**
 * Lexical index over chunk text plus the reference fields a retrieval query must pre-filter by.
 * `dynamic: false` with an explicit field list keeps `tenantId`/`documentId`/`documentVersionId`
 * out of full-text analysis — they are exact-match filter fields (`token`/`objectId`), not
 * searchable text, so a `$search` compound `filter` clause can match them precisely.
 */
const searchIndex: SearchIndexDescription = {
  name: SEARCH_INDEX,
  type: 'search',
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        text: { type: 'string' },
        tenantId: { type: 'token' },
        documentId: { type: 'objectId' },
        documentVersionId: { type: 'objectId' },
      },
    },
  },
};

/**
 * `similarity: 'cosine'` over `dotProduct` is a deliberate correctness choice, not a default.
 * `dotProduct` is only equivalent to cosine similarity when every stored vector is unit-length;
 * nothing in `VoyageEmbeddingProvider` (`src/providers/embedding/voyage-embedding.provider.ts`)
 * requests or asserts normalization from the Voyage API. Betting on an unconfirmed normalization
 * guarantee would trade a small, constant compute saving for a failure mode that is invisible —
 * a `dotProduct` index over non-normalized vectors still returns a ranked list, just the wrong
 * ranking. `cosine` is correct regardless of vector magnitude.
 *
 * `tenantId` is declared as a `filter` field (not indexed in `fields` as a vector) so
 * `$vectorSearch`'s `filter` clause can pre-filter candidates by tenant before the ANN search
 * runs, rather than filtering the result set after.
 *
 * Built as a function, not a module-level constant, so `resolveVectorDimensions()` — and the
 * error it can throw on an invalid `VOYAGE_DIMENSIONS` — only runs during `up()`. Evaluating it
 * at module load would also run it for `down()` and `migrate-mongo status`, where a bad vector
 * width is irrelevant to the operation being performed.
 */
function buildVectorIndex(): SearchIndexDescription {
  return {
    name: VECTOR_INDEX,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embedding',
          numDimensions: resolveVectorDimensions(),
          similarity: 'cosine',
        },
        {
          type: 'filter',
          path: 'tenantId',
        },
      ],
    },
  };
}

export const up = async (db: Db): Promise<void> => {
  // `createSearchIndexes` requires the collection to already exist — unlike `createIndex`, which
  // creates it implicitly (which is why 0001/0002 never needed this). On a fresh deployment
  // migrations run before a single document is written, so without this the very first
  // `migrate:up` fails with "Collection 'evidence_chunks' does not exist". Verified against a
  // live Atlas Local instance, not inferred.
  const collections = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).toArray();
  if (collections.length === 0) {
    await db.createCollection(COLLECTION);
  }

  await db.collection(COLLECTION).createSearchIndexes([searchIndex, buildVectorIndex()]);

  // Both builds run concurrently on the server; wait for each so `up()` never reports success
  // while an index is still building — a migration that "succeeds" early hands the next reader
  // a store that silently returns nothing until the build catches up.
  await waitForSearchIndexReady(db, COLLECTION, SEARCH_INDEX);
  await waitForSearchIndexReady(db, COLLECTION, VECTOR_INDEX);
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropSearchIndex(SEARCH_INDEX);
  await db.collection(COLLECTION).dropSearchIndex(VECTOR_INDEX);
};
