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

/**
 * Fetches the open-conflict, pending-approval, and proposed-measure counts the Adjudication and
 * Measures queue badges display. `limit: 1` reads the response envelope only; the rows it
 * carries are discarded and `count` is the sole field read. A count is decoration, never
 * load-bearing: any of the three fetches failing resolves that count to `null` rather than
 * rejecting, so one broken count never takes the nav down with it. Refetches on pathname change
 * and nothing else — no polling, no interval.
 *
 * Waits for an authed session before fetching any endpoint: all three sit behind the global auth
 * guard, and firing them while a visit is still anonymous would race the sidebar's own render
 * (which mounts outside `RequireAuth`) against `RequireAuth`'s redirect to `/login`.
 */
export function usePendingCounts(): PendingCounts {
  const location = useLocation();
  const session = useSession();
  const isAuthed = session.status === 'authed';
  const [counts, setCounts] = useState<PendingCounts>(EMPTY_COUNTS);

  useEffect(() => {
    // No reset to EMPTY_COUNTS here: the one route from authed back to anonymous — logout — takes
    // `Sidebar` out of the tree via a full navigation to `/login` before this could ever run
    // again with `isAuthed` false, so there is no stale count left on screen to clear.
    if (!isAuthed) return;

    let cancelled = false;

    listConflicts({ status: 'open', limit: 1 })
      .then((result) => {
        if (!cancelled) setCounts((prev) => ({ ...prev, conflicts: result.count }));
      })
      .catch(() => {
        if (!cancelled) setCounts((prev) => ({ ...prev, conflicts: null }));
      });

    listApprovals({ state: 'pending', limit: 1 })
      .then((result) => {
        if (!cancelled) setCounts((prev) => ({ ...prev, approvals: result.count }));
      })
      .catch(() => {
        if (!cancelled) setCounts((prev) => ({ ...prev, approvals: null }));
      });

    listMeasures({ status: 'proposed', limit: 1 })
      .then((result) => {
        if (!cancelled) setCounts((prev) => ({ ...prev, measures: result.count }));
      })
      .catch(() => {
        if (!cancelled) setCounts((prev) => ({ ...prev, measures: null }));
      });

    return () => {
      cancelled = true;
    };
  }, [location.pathname, isAuthed]);

  return counts;
}
