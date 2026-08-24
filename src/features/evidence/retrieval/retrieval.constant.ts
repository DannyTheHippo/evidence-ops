/** Each search spends a live embedding call (`EvidenceRetrievalService.retrieve` →
 *  `RetrievalStore.search`), so this bounds spend rather than protecting a cheap read. */
export const RETRIEVAL_SEARCH_THROTTLE_LIMIT = 10;

/**
 * `EvidenceRetrievalService.retrieve` asks the store for `config.retrieval.limit * this` and
 * drops withdrawn chunks afterward, so a withdrawn chunk doesn't shrink the caller's requested
 * result count as long as enough live chunks exist in the wider pool.
 */
export const RETRIEVAL_OVER_FETCH_MULTIPLIER = 2;
