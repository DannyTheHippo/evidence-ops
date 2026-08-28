import { useCallback, useMemo } from 'react';
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
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo(() => {
    const result = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const value = searchParams.get(key as string);
      if (value !== null) result[key] = value as T[keyof T];
    }
    return result;
  }, [defaults, searchParams]);

  const setState = useCallback(
    (patch: Partial<T>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const key of Object.keys(patch) as Array<keyof T>) {
            const value = patch[key];
            if (value === undefined) continue;
            if (value === defaults[key]) {
              next.delete(key as string);
            } else {
              next.set(key as string, value);
            }
          }
          return next;
        },
        { replace: true },
      );
    },
    [defaults, setSearchParams],
  );

  return [state, setState];
}
