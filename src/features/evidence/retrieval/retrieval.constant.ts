/** Each search spends a live embedding call (`EvidenceRetrievalService.retrieve` →
 *  `RetrievalStore.search`), so this bounds spend rather than protecting a cheap read. */
export const RETRIEVAL_SEARCH_THROTTLE_LIMIT = 10;
