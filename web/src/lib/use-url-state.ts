import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The URL vocabulary for a list page: filters, sort and paging round-trip through the query
 * string instead of component state, so a reload or a shared link reproduces the same view.
 * Reading always returns every key in `defaults`, substituting the default for any key absent
 * from the URL; a key whose current value equals its default is omitted when writing, so a page
 * left at its defaults keeps a clean address bar. A patch merges over the current state — a key
 * not present in the patch keeps whatever value it already had. Updates go through
 * `setSearchParams`'s `replace` option rather than the default `push`: twenty filter tweaks must
 * not turn into twenty history entries that Back then has to walk back through one at a time.
 *
 * `defaults` needs to be stable only **in value** (the same keys and values across renders), never
 * in identity — the natural call style is an inline object literal. `state` and `setState` stay
 * referentially stable across a re-render that passes such a literal, because the hook adopts
 * `defaults` once, on mount, and keeps that identity for its lifetime.
 *
 * `setState` accumulates patches across calls that land in the same render: react-router's
 * `setSearchParams` updater form evaluates against the render's captured `searchParams`
 * immediately rather than queuing, so two calls in one event handler would otherwise share that
 * stale base and the second would overwrite the first. A ref holds the params built up so far
 * within the current render and is cleared once `searchParams` itself changes.
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  // `useState`'s non-function initial-value form reads its argument only on the first render and
  // ignores it on every later one, so this captures whatever object the caller passed on mount and
  // keeps that identity for the hook's lifetime — sufficient given `defaults` only needs to be
  // stable in value, never in identity, and covers the natural call style of an inline literal.
  const [stableDefaults] = useState(defaults);

  // Read and written only from the updater callback below and this effect — never during render
  // itself — so accumulating patches across same-render `setState` calls never touches a ref
  // outside those two places.
  const pendingRef = useRef<URLSearchParams | null>(null);
  useEffect(() => {
    pendingRef.current = null;
  }, [searchParams]);

  const state = useMemo(() => {
    const result = { ...stableDefaults };
    for (const key of Object.keys(stableDefaults) as Array<keyof T>) {
      const value = searchParams.get(key as string);
      if (value !== null) result[key] = value as T[keyof T];
    }
    return result;
  }, [searchParams, stableDefaults]);

  const setState = useCallback(
    (patch: Partial<T>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(pendingRef.current ?? current);
          for (const key of Object.keys(patch) as Array<keyof T>) {
            const value = patch[key];
            if (value === undefined) continue;
            if (value === stableDefaults[key]) {
              next.delete(key as string);
            } else {
              next.set(key as string, value);
            }
          }
          pendingRef.current = next;
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams, stableDefaults],
  );

  return [state, setState];
}
