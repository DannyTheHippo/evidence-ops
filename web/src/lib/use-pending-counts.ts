import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { listApprovals, listConflicts, listMeasures } from '../api/client';
import { useSession } from './use-session';

/** Badge counts for the Adjudication and Measures queue badges. `null` means "not known yet" or
 * "failed to load" — the sidebar treats both the same as "render no badge". */
export interface PendingCounts {
  conflicts: number | null;
  approvals: number | null;
  measures: number | null;
}

const EMPTY_COUNTS: PendingCounts = { conflicts: null, approvals: null, measures: null };

type PendingCountsInvalidationListener = () => void;

const invalidationListeners = new Set<PendingCountsInvalidationListener>();

/** Publishes a refetch request to every mounted `usePendingCounts()` — call after a decision
 * (an approval, a conflict resolution, a measure verdict) changes one of the three counts. */
export function invalidatePendingCounts(): void {
  for (const listener of invalidationListeners) listener();
}

export function subscribePendingCountsInvalidation(
  listener: PendingCountsInvalidationListener,
): void {
  invalidationListeners.add(listener);
}

export function unsubscribePendingCountsInvalidation(
  listener: PendingCountsInvalidationListener,
): void {
  invalidationListeners.delete(listener);
}

type PendingCountsListener = (counts: PendingCounts) => void;

// Module-scope, mirroring `announce.ts` and `breadcrumbs.ts`: every mounted `usePendingCounts()`
// reads this one snapshot instead of running its own fetch loop, so the Sidebar badge and
// AdjudicationPage's segment counts can never disagree and a page never issues the same three
// requests twice.
const countsListeners = new Set<PendingCountsListener>();
let sharedCounts: PendingCounts = EMPTY_COUNTS;

function publishCounts(next: PendingCounts): void {
  sharedCounts = next;
  for (const listener of countsListeners) listener(next);
}

interface EngineContext {
  pathname: string;
  isAuthed: boolean;
  // Distinguishes one signed-in account from the next at the same pathname, so switching users
  // without an intervening navigation still resyncs the engine instead of keeping the previous
  // account's counts on screen.
  userId: string | null;
}

function sameContext(a: EngineContext, b: EngineContext): boolean {
  return a.pathname === b.pathname && a.isAuthed === b.isAuthed && a.userId === b.userId;
}

// Starts the fetch loop: an immediate load(), then a reload on every invalidation publish and on
// the document becoming visible, with no polling interval of its own. Returns the teardown that
// `releaseEngine`/`syncEngine` runs when the loop is superseded or the last subscriber leaves.
function startEngine(): () => void {
  let cancelled = false;
  // Incremented on every load() call within this engine's lifetime (start, an invalidation
  // publish, a visibility change); a field only applies a response that still matches the
  // sequence it was issued under, so a slow load() overtaken by a newer one never clobbers the
  // fresher counts with a stale answer.
  let sequence = 0;

  function load(): void {
    const requestSequence = ++sequence;

    listConflicts({ status: 'open', limit: 1 })
      .then((result) => {
        if (!cancelled && requestSequence === sequence) {
          publishCounts({ ...sharedCounts, conflicts: result.count });
        }
      })
      .catch(() => {
        if (!cancelled && requestSequence === sequence) {
          publishCounts({ ...sharedCounts, conflicts: null });
        }
      });

    listApprovals({ state: 'pending', limit: 1 })
      .then((result) => {
        if (!cancelled && requestSequence === sequence) {
          publishCounts({ ...sharedCounts, approvals: result.count });
        }
      })
      .catch(() => {
        if (!cancelled && requestSequence === sequence) {
          publishCounts({ ...sharedCounts, approvals: null });
        }
      });

    listMeasures({ status: 'proposed', limit: 1 })
      .then((result) => {
        if (!cancelled && requestSequence === sequence) {
          publishCounts({ ...sharedCounts, measures: result.count });
        }
      })
      .catch(() => {
        if (!cancelled && requestSequence === sequence) {
          publishCounts({ ...sharedCounts, measures: null });
        }
      });
  }

  load();

  function handleVisibility(): void {
    if (document.visibilityState === 'visible') load();
  }

  subscribePendingCountsInvalidation(load);
  document.addEventListener('visibilitychange', handleVisibility);

  return () => {
    cancelled = true;
    unsubscribePendingCountsInvalidation(load);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}

let refCount = 0;
let activeContext: EngineContext | null = null;
let stopEngine: (() => void) | null = null;

// Re-syncs the one running engine to `next`, starting or restarting it only when the pathname,
// auth state or signed-in user actually changed — a second subscriber mounting with the same
// context is a no-op, which is what collapses the sidebar's and AdjudicationPage's fetch loops
// into one. Never touches `refCount`: subscriber lifetime is tracked separately by
// `acquireEngine`/`releaseEngine`, so a route change never dips the count and stops the engine
// out from under a subscriber that never unmounted. Publishes `EMPTY_COUNTS` itself when the new
// context is signed out, so a sign-out or a user switch clears the badges on its own rather than
// depending on the previous account's consumers happening to unmount first.
function syncEngine(next: EngineContext): void {
  if (activeContext && sameContext(activeContext, next)) return;
  activeContext = next;
  stopEngine?.();
  stopEngine = null;
  if (!next.isAuthed) {
    publishCounts(EMPTY_COUNTS);
    return;
  }
  stopEngine = startEngine();
}

// Counts subscribers only; a context change never runs this, so mounting a second consumer at the
// same pathname doesn't restart the engine and a route change on an already-mounted consumer
// doesn't dip the count to 0.
function acquireEngine(): void {
  refCount += 1;
}

function releaseEngine(): void {
  refCount -= 1;
  if (refCount > 0) return;
  refCount = 0;
  stopEngine?.();
  stopEngine = null;
  activeContext = null;
  publishCounts(EMPTY_COUNTS);
}

/**
 * Reads the open-conflict, pending-approval, and proposed-measure counts the Adjudication and
 * Measures queue badges display. One engine, re-synced to the latest (pathname, auth, user)
 * context, shared by every mounted caller — `Sidebar` and `AdjudicationPage` both read the same
 * snapshot rather than each running its own `listConflicts`/`listApprovals`/`listMeasures`
 * triplet. `limit: 1` reads the response envelope only; the rows it carries are discarded and
 * `count` is the sole field read. A count is decoration, never load-bearing: any of the three
 * fetches failing resolves that count to `null` rather than rejecting, so one broken count never
 * takes the nav down with it. Refetches on pathname change, on an `invalidatePendingCounts()`
 * publish, and on the document becoming visible, with no polling interval of its own. The counts
 * a consumer last rendered stay on screen across a route change until the refetch resolves —
 * `Sidebar` and `AdjudicationPage` are never left disagreeing with a blanked badge while a
 * request is in flight.
 *
 * Waits for an authed session before fetching any endpoint: all three sit behind the global auth
 * guard, and firing them while a visit is still anonymous would race the sidebar's own render
 * (which mounts outside `RequireAuth`) against `RequireAuth`'s redirect to `/login`.
 */
export function usePendingCounts(): PendingCounts {
  const location = useLocation();
  const session = useSession();
  const isAuthed = session.status === 'authed';
  const userId = session.status === 'authed' ? session.me.id : null;
  const [counts, setCounts] = useState<PendingCounts>(sharedCounts);
  // Re-synced during render rather than inside the effect below, on the same
  // `AttestationBundleView`/`DateRange` pattern — a synchronous `setCounts` inside an effect body
  // trips `react-hooks/set-state-in-effect`, and this bails out on the very same render instead of
  // committing a stale snapshot and re-triggering another. Without it, a publish landing between a
  // render and the listener-registration effect below would sit unseen by this consumer until the
  // next publish.
  if (counts !== sharedCounts) {
    setCounts(sharedCounts);
  }

  useEffect(() => {
    countsListeners.add(setCounts);
    return () => {
      countsListeners.delete(setCounts);
    };
  }, []);

  // Subscriber lifetime, counted once per mount regardless of how often the context below
  // changes — see `syncEngine`'s comment for why this has to be a separate effect from the one
  // that follows.
  useEffect(() => {
    acquireEngine();
    return releaseEngine;
  }, []);

  useEffect(() => {
    syncEngine({ pathname: location.pathname, isAuthed, userId });
  }, [location.pathname, isAuthed, userId]);

  return counts;
}
