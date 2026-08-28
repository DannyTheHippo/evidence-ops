import { useEffect, useState } from 'react';

/** One crumb in a page's trail. `to` is the link target; the last crumb in a trail — the current
 * page — never carries one, and the topbar renders it as plain text with `aria-current="page"`
 * instead of a link. */
export interface BreadcrumbItem {
  label: string;
  to?: string;
}

type BreadcrumbListener = (trail: BreadcrumbItem[]) => void;

let currentTrail: BreadcrumbItem[] = [];
const listeners = new Set<BreadcrumbListener>();

export function subscribeBreadcrumbs(listener: BreadcrumbListener): void {
  listeners.add(listener);
}

export function unsubscribeBreadcrumbs(listener: BreadcrumbListener): void {
  listeners.delete(listener);
}

function publishBreadcrumbTrail(trail: BreadcrumbItem[]): void {
  currentTrail = trail;
  for (const listener of listeners) listener(trail);
}

export function getBreadcrumbTrail(): BreadcrumbItem[] {
  return currentTrail;
}

/**
 * Publishes a page's breadcrumb trail — Section › Page › Record, three levels at most — for the
 * topbar and `document.title` to read. Module-scope publish/subscribe, mirroring
 * `use-event-stream.ts`'s stream-status channel, rather than a context provider: a page publishes
 * once it knows its trail and the chrome, which sits outside that page's own subtree, picks it up.
 *
 * Keys its effect on `JSON.stringify(trail)`, not on `trail` itself: a caller builds the array as
 * an inline literal at the call site, so a new identity lands on every render even when the
 * content is unchanged. Keying on identity would fire the effect — and republish — every render;
 * requiring every caller to wrap its literal in `useMemo` just moves the trap rather than closing
 * it.
 *
 * Unmounting clears the trail rather than leaving it behind, the same way a stream's status
 * resets to `idle` on unmount — a page holding no trail must not leave the previous page's crumbs
 * on screen after navigating away from it. That clear lives in its own empty-deps effect rather
 * than as the content-publish effect's cleanup: a `useEffect` cleanup runs before every
 * re-invocation, not only on unmount, so folding it into the first effect would publish `[]`
 * between every two genuine trail updates — an update, not just a departure, would appear to
 * every subscriber as a moment with no trail at all.
 */
export function useBreadcrumbs(trail: BreadcrumbItem[]): void {
  const key = JSON.stringify(trail.slice(0, 3));

  useEffect(() => {
    publishBreadcrumbTrail(JSON.parse(key) as BreadcrumbItem[]);
  }, [key]);

  useEffect(() => {
    return () => publishBreadcrumbTrail([]);
  }, []);
}

/** Reactive subscriber for the currently published trail, falling back to `fallback` — usually a
 * single Page-level crumb derived from the route — while nothing has published one: before any
 * page adopts `useBreadcrumbs`, and immediately after navigating to one that has not. */
export function useBreadcrumbTrail(fallback: BreadcrumbItem[]): BreadcrumbItem[] {
  const [trail, setTrail] = useState<BreadcrumbItem[]>(getBreadcrumbTrail);

  useEffect(() => {
    subscribeBreadcrumbs(setTrail);
    return () => unsubscribeBreadcrumbs(setTrail);
  }, []);

  return trail.length > 0 ? trail : fallback;
}
