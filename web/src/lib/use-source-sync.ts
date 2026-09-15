import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getSourceById,
  requestSourceSync,
  type Source,
  type WorkflowRun,
} from '../api/client';
import { notify } from '../components/ui/toast';
import { isTerminalRun } from './workflow-runs';

const DEFAULT_POLL_INTERVAL_MS = 1500;
const SWEEP_POLL_CAP_MS = 60_000;

export interface SourceSyncState {
  run: WorkflowRun | null;
  isPolling: boolean;
  starting: boolean;
  syncError: string | null;
  sweepState: 'idle' | 'waiting' | 'settled' | 'timed-out' | 'gone';
  source: Source | null;
  startSync: (sourceId: string, sourceName: string) => Promise<void>;
}

/** Names the sync **loop**, not the one sweep `startSync` just requested — `requestSourceSync`
 * returns the loop's run whether it just started or was already running, and that run only ever
 * reaches a terminal status when the loop itself stops, not when one sweep finishes. A non-terminal
 * run means the loop is still scheduling sweeps; `completed` means the loop stopped; `failed` means
 * the loop errored out, never that a single sweep failed. */
export function syncRunLabel(run: WorkflowRun): string {
  if (!isTerminalRun(run.status)) return 'Sync loop running';
  return run.status === 'completed' ? 'Sync loop stopped' : 'Sync failed';
}

interface SweepTarget {
  sourceId: string;
  requestedAt: number;
}

/**
 * Triggers a source's sync and polls the **source**, not the sync loop's run, until the sweep it
 * just requested finishes. `requestSourceSync` returns the loop's existing run when one is already
 * in progress, and that run carries no timestamp a caller could use to tell whether the requested
 * sweep has actually started — so `startSync` records `requestedAt` before calling it, then polls
 * `getSourceById` until the source's `lastSyncAt` advances past that moment (`sweepState`
 * `'settled'`) or `SWEEP_POLL_CAP_MS` elapses (`'timed-out'` — not an error, since the loop keeps
 * sweeping on its own interval either way). A poll that keeps failing also ends at `'timed-out'`
 * once the cap passes rather than retrying forever. A 404 — the source no longer exists — ends the
 * sweep immediately at `'gone'` instead of waiting for the cap, since no later poll will ever
 * settle it; both `'timed-out'` and `'gone'` leave the last `syncError` set. `source`
 * always holds the freshest poll read, whatever
 * `sweepState` it stopped at; `isPolling` is `sweepState === 'waiting'`. `SourcesPage` mounts one
 * instance per row and `SourceDetailPage` mounts a single instance for the one source in view.
 *
 * The success toast is worded the same on both server branches (`Sync requested for
 * ${sourceName}.`) since a caller cannot tell which branch fired and both mean the same thing to a
 * user. A failed start is reported through `syncError` only — every caller already renders it
 * inline, so a toast would report the same failure a second time.
 *
 * `onSettled`, when supplied, fires exactly once per sweep that reaches `'settled'`.
 * `SourceDetailPage` uses it to reload the source and its class drift count, since neither updates
 * on its own once the sweep that changed them finishes; a caller that omits it (every existing
 * `SourcesPage` row) sees no change in behaviour.
 */
export function useSourceSync(
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  onSettled?: () => void,
): SourceSyncState {
  const [starting, setStarting] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [sweepState, setSweepState] = useState<SourceSyncState['sweepState']>('idle');
  const [sweepTarget, setSweepTarget] = useState<SweepTarget | null>(null);

  // Refreshed every render (mirroring `useEventStream`'s `callbacksRef`) so the settle effect below
  // never closes over a stale `onSettled`, keeping its own dependency array honestly at
  // [sweepState] rather than a caller's own function identity, which is free to change on every
  // render without SourcesPage or SourceDetailPage needing to memoize it.
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  async function startSync(sourceId: string, sourceName: string): Promise<void> {
    setStarting(true);
    setSyncError(null);
    const requestedAt = Date.now();
    try {
      const started = await requestSourceSync(sourceId);
      setRun(started);
      notify('success', `Sync requested for ${sourceName}.`);
      setSweepState('waiting');
      setSweepTarget({ sourceId, requestedAt });
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : 'Failed to start sync');
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!sweepTarget) return;
    const { sourceId, requestedAt } = sweepTarget;
    const deadline = requestedAt + SWEEP_POLL_CAP_MS;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // A recursive setTimeout (not setInterval), matching use-answer-run.ts's poll loop: the next
    // poll is only ever scheduled once the current one has settled, so a slow response can never
    // overlap the next attempt. The deadline is checked before every poll fires and again on both
    // outcomes, so a run of failures — or the cap simply passing between ticks — always reaches
    // 'timed-out' instead of polling past it forever.
    const poll = () => {
      if (Date.now() >= deadline) {
        setSweepState('timed-out');
        setSweepTarget(null);
        return;
      }
      if (inFlight) return;
      inFlight = true;

      getSourceById(sourceId)
        .then((next) => {
          inFlight = false;
          if (cancelled) return;
          setSource(next);
          const settled =
            next.lastSyncAt !== undefined && Date.parse(next.lastSyncAt) > requestedAt;
          if (settled) {
            setSweepState('settled');
            setSweepTarget(null);
            return;
          }
          if (Date.now() >= deadline) {
            setSweepState('timed-out');
            setSweepTarget(null);
            return;
          }
          timer = setTimeout(poll, pollIntervalMs);
        })
        .catch((err: unknown) => {
          inFlight = false;
          if (cancelled) return;
          setSyncError(err instanceof Error ? err.message : 'Failed to poll source');
          // The source is gone; no later poll will ever settle it, so the sweep ends at once
          // rather than retrying it until the cap passes — at its own terminal state, not
          // 'timed-out', since the loop is not still sweeping on a source that no longer exists.
          if (err instanceof ApiError && err.status === 404) {
            setSweepState('gone');
            setSweepTarget(null);
            return;
          }
          if (Date.now() >= deadline) {
            setSweepState('timed-out');
            setSweepTarget(null);
            return;
          }
          timer = setTimeout(poll, pollIntervalMs);
        });
    };

    timer = setTimeout(poll, pollIntervalMs);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [sweepTarget, pollIntervalMs]);

  // Fires once per sweep that reaches 'settled' — clearing sweepTarget in the poll effect above
  // means this only ever sees the transition once, never a repeat for the same sweep.
  useEffect(() => {
    if (sweepState !== 'settled') return;
    onSettledRef.current?.();
  }, [sweepState]);

  const isPolling = sweepState === 'waiting';

  return { run, isPolling, starting, syncError, sweepState, source, startSync };
}
