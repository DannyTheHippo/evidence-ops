import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  getSourceById,
  getWorkflowRunById,
  requestSourceSync,
  setSourceEnabled,
  type SourceWithFileStates,
  type WorkflowRun,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';
import { formatInterval } from '../lib/format-interval';
import { isTerminalRun } from '../lib/workflow-runs';

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface SourceDetailPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

export default function SourceDetailPage({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: SourceDetailPageProps) {
  const { id } = useParams<{ id: string }>();
  const [source, setSource] = useState<SourceWithFileStates | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);

  useEffect(() => {
    if (!id) return;
    getSourceById(id)
      .then((result) => {
        setSource(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load source');
      });
  }, [id]);

  async function handleToggle() {
    if (!source) return;
    setToggling(true);
    setToggleError(null);
    try {
      const updated = await setSourceEnabled(source.id, !source.enabled);
      setSource((current) => (current ? { ...current, ...updated } : current));
    } catch (err: unknown) {
      setToggleError(err instanceof Error ? err.message : 'Failed to update source');
    } finally {
      setToggling(false);
    }
  }

  async function handleSync() {
    if (!source) return;
    setStarting(true);
    setSyncError(null);
    try {
      const started = await requestSourceSync(source.id);
      setRun(started);
      notify('success', `Sync started for ${source.name}.`);
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

  // Polls the triggered sync's workflow run while it is in flight, stopping the moment its status
  // reaches a terminal state rather than polling forever. Mirrors SourcesPage's row-level poll —
  // this page only ever has the one source in view, so it is a single interval, not a per-row one.
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
  // A carried lastSyncError under the "enabled" label reads as caution, not verified-green — the
  // same register the list page's combined status carries for the same state, so the badge here
  // never contradicts the "Last sync failed" notice sitting directly beneath it.
  const status: { tone: 'verified' | 'caution' | 'info' | 'neutral'; label: string } = isPolling
    ? { tone: 'info', label: 'syncing' }
    : {
        tone: source?.enabled ? (source.lastSyncError ? 'caution' : 'verified') : 'neutral',
        label: source?.enabled ? 'enabled' : 'disabled',
      };

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">{source ? source.name : 'Source'}</h1>
          <p className="page-sub">Per-file sync state for this source.</p>
        </div>
        <Link to="/sources" className="btn btn--secondary btn--sm">
          Back to sources
        </Link>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!id && (
        <p className="error error--page" role="alert">
          No source id provided.
        </p>
      )}

      {notFound && <p className="notice notice--info">Source not found.</p>}

      {!source && !error && !notFound && id && <Skeleton label="Loading…" />}

      {source && (
        <>
          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title mono">{source.path}</h2>
                <p className="cell-sub">{formatInterval(source.intervalMs)}</p>
              </div>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <p className="cell-sub">
              {source.lastSyncAt
                ? `Last synced ${new Date(source.lastSyncAt).toLocaleString()}`
                : 'Never synced'}
            </p>
            {source.lastSyncError && (
              <p className="notice notice--warn">Last sync failed: {source.lastSyncError}</p>
            )}
            <div className="form-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={toggling}
                onClick={() => void handleToggle()}
              >
                {toggling ? 'Updating…' : source.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={starting}
                onClick={() => void handleSync()}
              >
                {starting ? 'Starting…' : 'Sync now'}
              </Button>
              {run && (
                <Link to={`/workflow-runs/${run.id}`}>
                  {isPolling && <span className="badge-dot" />}
                  {isTerminalRun(run.status) ? `Sync ${run.status}` : 'Sync running…'}
                </Link>
              )}
            </div>
            {toggleError && (
              <p className="error" role="alert">
                {toggleError}
              </p>
            )}
            {syncError && (
              <p className="error" role="alert">
                {syncError}
              </p>
            )}
          </section>

          <section className="panel">
            {source.fileStates.length === 0 ? (
              <EmptyState
                title="No files synced yet."
                description="File status appears here after the source's next sync."
              />
            ) : (
              <Table caption="Per-file sync status for this source">
                <thead>
                  <tr>
                    <TableHeaderCell>File</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Last error</TableHeaderCell>
                    <TableHeaderCell>Last modified</TableHeaderCell>
                  </tr>
                </thead>
                <tbody>
                  {source.fileStates.map((fileState) => (
                    <tr key={fileState.path}>
                      <td className="mono">{fileState.path}</td>
                      <td>
                        <Badge tone={fileState.lastError ? 'rejected' : 'verified'}>
                          {fileState.status}
                        </Badge>
                      </td>
                      <td className="cell-sub">{fileState.lastError ?? '—'}</td>
                      <td className="cell-sub">{new Date(fileState.mtimeMs).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
