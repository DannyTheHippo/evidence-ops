import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  createSource,
  getWorkflowRunById,
  listSources,
  requestSourceSync,
  setSourceEnabled,
  type Source,
  type WorkflowRun,
} from '../api/client';

const DEFAULT_POLL_INTERVAL_MS = 1500;

function enabledBadge(enabled: boolean): { className: string; label: string } {
  return enabled
    ? { className: 'badge badge--strong', label: 'enabled' }
    : { className: 'badge badge--neutral', label: 'disabled' };
}

function isTerminalRun(status: WorkflowRun['status']): boolean {
  return status === 'completed' || status === 'failed';
}

function SourceRow({
  source,
  pollIntervalMs,
  onToggled,
}: {
  source: Source;
  pollIntervalMs: number;
  onToggled: (updated: Source) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);

  async function handleToggle() {
    setToggling(true);
    setToggleError(null);
    try {
      const updated = await setSourceEnabled(source.id, !source.enabled);
      onToggled(updated);
    } catch (err: unknown) {
      setToggleError(err instanceof Error ? err.message : 'Failed to update source');
    } finally {
      setToggling(false);
    }
  }

  async function handleSync() {
    setStarting(true);
    setSyncError(null);
    try {
      setRun(await requestSourceSync(source.id));
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : 'Failed to start sync');
    } finally {
      setStarting(false);
    }
  }

  const runId = run?.id;
  const runStatus = run?.status;

  // Polls the triggered sync's workflow run while it is in flight, stopping the moment its status
  // reaches a terminal state rather than polling forever. Depends on the id and status values, not
  // the `run` object, so one interval spans every tick that reports the same status and the poll
  // cadence stays fixed rather than drifting by the response latency of each tick. `cancelled`
  // drops a response that lands after this effect is torn down — after unmount, or after a newer
  // tick moved the run on — instead of overwriting fresher state.
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

  const badge = enabledBadge(source.enabled);
  const isPolling = !!run && !isTerminalRun(run.status);

  return (
    <tr>
      <td>
        <Link to={`/sources/${source.id}`}>{source.name}</Link>
      </td>
      <td className="cell-sub mono">{source.path}</td>
      <td>
        <span className={badge.className}>{badge.label}</span>
      </td>
      <td className="cell-sub">
        {source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : 'Never synced'}
        {source.lastSyncStatus && <div>{source.lastSyncStatus}</div>}
        {source.lastSyncError && <div>{source.lastSyncError}</div>}
      </td>
      <td className="num">{source.fileCount}</td>
      <td>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={toggling}
            onClick={() => void handleToggle()}
          >
            {toggling ? 'Updating…' : source.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={starting}
            onClick={() => void handleSync()}
          >
            {starting ? 'Starting…' : 'Sync now'}
          </button>
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
      </td>
    </tr>
  );
}

interface SourcesPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

export default function SourcesPage({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: SourcesPageProps) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [intervalMs, setIntervalMs] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    listSources()
      .then(({ docs }) => setSources(docs))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load sources');
      });
  }, []);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createSource({
        name,
        kind: 'local-folder',
        path,
        intervalMs: intervalMs.trim() ? Number(intervalMs) : undefined,
      });
      setSources((current) => [created, ...(current ?? [])]);
      setName('');
      setPath('');
      setIntervalMs('');
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create source');
    } finally {
      setCreating(false);
    }
  }

  function handleToggled(updated: Source) {
    setSources((current) => current?.map((s) => (s.id === updated.id ? updated : s)) ?? current);
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">Sources</h1>
          <p className="page-sub">Point at a folder and watch it sync documents in.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Add a source</h2>
        </div>
        <form onSubmit={(e) => void handleCreate(e)} className="form">
          <label>
            Name
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Deal Room Inbox"
            />
          </label>
          <label>
            Folder path
            <input
              type="text"
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="deal-room"
            />
          </label>
          <label>
            Sync interval (ms, optional)
            <input
              type="number"
              min={1}
              value={intervalMs}
              onChange={(e) => setIntervalMs(e.target.value)}
              placeholder="60000"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={creating}>
              {creating ? 'Adding…' : 'Add source'}
            </button>
          </div>
        </form>
        {createError && (
          <p className="error" role="alert">
            {createError}
          </p>
        )}
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!sources && !error && <p>Loading…</p>}

      {sources && sources.length === 0 && (
        <p className="notice notice--info">No sources yet — add one to start syncing documents.</p>
      )}

      {sources && sources.length > 0 && (
        <section className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Path</th>
                <th>Status</th>
                <th>Last sync</th>
                <th>Files</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  pollIntervalMs={pollIntervalMs}
                  onToggled={handleToggled}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
