import { useEffect, useState } from 'react';
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
 */
export function useSourceSync(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): SourceSyncState {
  const [starting, setStarting] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);

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

  const isPolling = !!run && !isTerminalRun(run.status);

  return { run, isPolling, starting, syncError, startSync };
}
