import { useCallback, useRef } from 'react';
import { announce } from './announce';

/**
 * Returns a stable `(filterKey, message) => void` for a list page's fetch success path. The first
 * call after mount records `filterKey` and announces nothing, so the initial load stays silent. A
 * later call whose `filterKey` differs from the recorded one calls `announce(message)` once and
 * records the new key; a call with the recorded key does nothing, so a refetch under the same
 * filters (paging, sorting, a retry) is not announced.
 */
export function useResultAnnouncer(): (filterKey: string, message: string) => void {
  const recordedKeyRef = useRef<string | null>(null);

  return useCallback((filterKey: string, message: string) => {
    const previousKey = recordedKeyRef.current;
    recordedKeyRef.current = filterKey;
    if (previousKey !== null && previousKey !== filterKey) announce(message);
  }, []);
}
