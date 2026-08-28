import { useCallback, useEffect, useRef, useState } from 'react';

const COPIED_RESET_MS = 2_000;

export interface CopyToClipboardState {
  copied: boolean;
  error: boolean;
  copy: (text: string) => void;
}

/**
 * Wraps the async Clipboard API write for a "Copy" button. `copied` flips true on a successful
 * write and clears itself after `COPIED_RESET_MS`; `error` flips true when the write could not
 * happen at all. `navigator.clipboard` is absent in non-secure contexts and older engines, and
 * `writeText` can reject even when it exists (permission denial, an unfocused document) — both
 * land on `error` rather than throwing, since a clipboard failure must never crash the page it's
 * copying from. The reset timer is cleared on unmount, and neither branch calls `setState` once
 * unmounted.
 */
export function useCopyToClipboard(): CopyToClipboardState {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // Set on every effect run, not just the first: the app renders under StrictMode, which mounts,
    // unmounts and remounts each component once. Without this the cleanup below would leave the
    // ref false for the remounted instance, and no copy would ever report success in development.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimeoutRef.current !== undefined) clearTimeout(resetTimeoutRef.current);
    };
  }, []);

  const copy = useCallback((text: string) => {
    if (resetTimeoutRef.current !== undefined) clearTimeout(resetTimeoutRef.current);

    if (!navigator.clipboard) {
      setCopied(false);
      setError(true);
      return;
    }

    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (!mountedRef.current) return;
        setError(false);
        setCopied(true);
        resetTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) setCopied(false);
        }, COPIED_RESET_MS);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setCopied(false);
        setError(true);
      });
  }, []);

  return { copied, error, copy };
}
