import { useEffect, useRef, useState } from 'react';
import { getWorkflowRunById, requestSourceSync, type WorkflowRun } from '../api/client';
import { notify } from '../components/ui/toast';
import { isTerminalRun } from './workflow-runs';

const DEFAULT_POLL_INTERVAL_MS = 1500;

export interface SourceSyncState {
  run: WorkflowRun | null;
  isPolling: boolean;
  starting: boolean;
  syncError: string | null;
  startSync: (sourceId: string, sourceName: string) => Promise<void>;
}

/** Keeps the sync action's name stable across its whole lifecycle — 'Sync now' on the button, then
 * this label for the resulting run: an in-flight run always reads as the same gerund, a terminal
 * one as a past-tense confirmation, never `run.status`'s raw enum value. */
export function syncRunLabel(run: WorkflowRun): string {
  if (!isTerminalRun(run.status)) return 'Syncing…';
  return run.status === 'completed' ? 'Synced' : 'Sync failed';
}

/**
 * Triggers a source's sync and polls the resulting workflow run until it reaches a terminal
 * state, stopping there rather than polling forever. The poll effect depends on the run's id and
 * status, not the `run` object itself, so one interval spans every tick that reports the same
 * status and the poll cadence stays fixed rather than drifting by each tick's response latency. A
 * per-effect `cancelled` flag drops a response that lands after the effect is torn down — after
 * unmount, or after a newer tick moved the run on — instead of setting state on an unmounted
 * component; StrictMode's double-mount re-arms a fresh effect (and a fresh `cancelled`) rather
 * than tripping a stale one, which a persistent ref would not do on its own. `SourcesPage` mounts
 * one instance per row and `SourceDetailPage` mounts a single instance for the one source in view.
 *
 * `onSettled`, when supplied, fires exactly once per run that reaches a terminal status — never
 * while a run is still polling. `SourceDetailPage` uses it to reload the source and its class
 * drift count, since neither updates on its own once the sync that changed them finishes; a caller
 * that omits it (every existing `SourcesPage` row) sees no change in behaviour.
 */
export function useSourceSync(
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  onSettled?: () => void,
): SourceSyncState {
  const [starting, setStarting] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);

  // Refreshed every render (mirroring `useEventStream`'s `callbacksRef`) so the terminal-run
  // effect below never closes over a stale `onSettled`, keeping its own dependency array honestly
  // at [runId, runStatus] rather than a caller's own function identity, which is free to change on
  // every render without SourcesPage or SourceDetailPage needing to memoize it.
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  async function startSync(sourceId: string, sourceName: string): Promise<void> {
    setStarting(true);
    setSyncError(null);
    try {
      const started = await requestSourceSync(sourceId);
      setRun(started);
      notify('success', `Sync started for ${sourceName}.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start sync';
      setSyncError(message);
      notify('error', message);
    } finally {
      setStarting(false);
    }
  }

  const runId = run?.id;
  const runStatus = run?.status;

  useEffect(() => {
    if (!runId || !runStatus || isTerminalRun(runStatus)) return;
    let cancelled = false;

    const timer = setInterval(() => {
      getWorkflowRunById(runId)
        .then((next) => {
          if (!cancelled) setRun(next);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSyncError(err instanceof Error ? err.message : 'Failed to poll sync run');
        });
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, runStatus, pollIntervalMs]);

  // Fires once for every run that reaches a terminal status — whether it started that way or a
  // poll tick above just moved it there — so a caller relying on `onSettled` alone can reload data
  // the sync just changed instead of showing whatever it read before the sync ran. Keyed on
  // [runId, runStatus] rather than `run` itself, matching the poll effect above: a run object that
  // deserialises fresh on every tick would otherwise refire this for every repeated terminal
  // status rather than once.
  useEffect(() => {
    if (!runId || !runStatus || !isTerminalRun(runStatus)) return;
    onSettledRef.current?.();
  }, [runId, runStatus]);

  const isPolling = !!run && !isTerminalRun(run.status);

  return { run, isPolling, starting, syncError, startSync };
}
