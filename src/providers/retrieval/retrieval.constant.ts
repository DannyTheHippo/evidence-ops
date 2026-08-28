// Duplicated from `migrations/0001-baseline.ts` rather than imported: `tsconfig.build.json`
// scopes `rootDir` to `src`, so `src` importing from `migrations/` would break `nest build`.
// `search-indexes.integration-spec.ts` is what keeps these two definitions honest against a live
// server — see that file rather than an import for the cross-check.
//
// Single source for every `src/**` consumer that needs to name this collection/index without
// depending on `MongoHybridRetrievalStore`'s concrete implementation: `IngestionService`
// (`ingestion.service.ts`), `MongoHybridRetrievalStore` itself, and `atlas-search-capability.util`
// all import from here.
export const COLLECTION = 'evidence_chunks';
export const SEARCH_INDEX = 'evidence_chunks_search';
export const VECTOR_INDEX = 'evidence_chunks_vector';
