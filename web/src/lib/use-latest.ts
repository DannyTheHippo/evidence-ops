import { useEffect, useRef, type DependencyList, type RefObject } from 'react';

/** Reads the freshest committed value from an event handler, timer callback, or promise
 * continuation without listing it as a dependency — mirrors `useObjectUrl`'s `fetchBlobRef`.
 * Written in an effect, never during render, so the ref never drives a re-render; a read that
 * runs synchronously during render, before that effect has committed, is one commit stale and
 * must not drive output. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Runs `effect` with a sequence-guarded `isCurrent()`; a response for a superseded run is
 * dropped, never rendered.
 */
export function useAbortableEffect(
  effect: (isCurrent: () => boolean) => void | Promise<void>,
  deps: DependencyList,
): void {
  useEffect(() => {
    let current = true;
    void effect(() => current);
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's dependency list is forwarded verbatim
  }, deps);
}
