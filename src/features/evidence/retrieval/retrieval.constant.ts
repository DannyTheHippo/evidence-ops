import type { SortDirection } from '../../../shared/constants/sort.constant';

/** Each search spends a live embedding call (`EvidenceRetrievalService.retrieve` →
 *  `RetrievalStore.search`), so this bounds spend rather than protecting a cheap read. */
export const RETRIEVAL_SEARCH_THROTTLE_LIMIT = 10;

/**
 * `EvidenceRetrievalService.retrieve` asks the store for `config.retrieval.limit * this` and
 * drops withdrawn chunks afterward, so a withdrawn chunk doesn't shrink the caller's requested
 * result count as long as enough live chunks exist in the wider pool.
 */
export const RETRIEVAL_OVER_FETCH_MULTIPLIER = 2;

/**
 * Only sort field `GET /retrieval/search` exposes — every other list endpoint sorts a Mongo
 * query directly, but a hybrid-retrieval hit's score exists only after `$rankFusion` runs, so
 * this is the one caller-chosen sort that reorders an already-fetched, in-memory result set
 * rather than a query.
 */
export const RETRIEVAL_SORT_FIELDS = ['score'] as const;
export type RetrievalSortField = (typeof RETRIEVAL_SORT_FIELDS)[number];

// Highest-relevance-first, matching the order `$rankFusion`/the app-side RRF fallback already
// produce — an explicit default rather than an accident of whatever order the store happens to
// return.
export const DEFAULT_RETRIEVAL_SORT_DIRECTION: SortDirection = 'desc';

/**
 * Caps the pool `EvidenceRetrievalService.searchEvidence` asks the store for, independent of how
 * large `skip + limit` grows. Without this, a deep page multiplies straight through
 * `RETRIEVAL_OVER_FETCH_MULTIPLIER` and then again through the store's own pipeline and
 * `$vectorSearch` candidate multipliers, turning one oversized page request into a search the
 * store was never sized for.
 */
export const MAX_RETRIEVAL_STORE_LIMIT = 500;
