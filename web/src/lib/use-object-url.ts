import { useEffect, useRef, useState } from 'react';

export interface ObjectUrlState {
  url: string | null;
  error: string | null;
}

/**
 * Fetches a `Blob` keyed on `key` and exposes it as a `blob:` object URL — the one place
 * `URL.revokeObjectURL` is called, so no page has to remember it. `key: null` disables the fetch
 * entirely and clears any held URL. Unmounting, or a `key` change, revokes whatever URL is current
 * at the time via the fetch effect's own cleanup below. `fetchBlob` is read from a ref refreshed
 * every render (mirroring `useEventStream`'s `callbacksRef`), so a caller's inline function does
 * not need to be memoized to keep this hook from refetching on every render — only `key` drives
 * the fetch effect.
 */
export function useObjectUrl<K extends string>(
  key: K | null,
  fetchBlob: (key: K) => Promise<Blob>,
): ObjectUrlState {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committedKey, setCommittedKey] = useState<K | null>(key);

  // Adjusts state directly during render rather than in an effect — the sanctioned pattern for
  // resetting derived state when a prop changes (react.dev/learn/you-might-not-need-an-effect),
  // matching WorkflowRunPage's use of it — so a `key` change clears the previous blob's url/error
  // in the same render pass instead of a stale PDF or error flashing for one extra render.
  if (key !== committedKey) {
    setCommittedKey(key);
    setUrl(null);
    setError(null);
  }

  const fetchBlobRef = useRef(fetchBlob);
  useEffect(() => {
    fetchBlobRef.current = fetchBlob;
  });

  useEffect(() => {
    if (!key) return;

    let cancelled = false;
    let created: string | null = null;

    fetchBlobRef
      .current(key)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load content');
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [key]);

  return { url, error };
}
