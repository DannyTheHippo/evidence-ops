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
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';

const DEFAULT_POLL_INTERVAL_MS = 1500;
const PAGE_SIZE = 20;

// An in-flight sync outranks everything else the row could report — it supersedes whatever status
// the last completed sync left behind. Disabled is neutral regardless of a carried error, since the
// row is not currently acting on its schedule either way. A carried lastSyncError only reads as
// rejected once the source is both enabled and idle; anything left over synced cleanly.
function sourceStatusTone(
  source: Source,
  isPolling: boolean,
): { tone: 'verified' | 'caution' | 'rejected' | 'info' | 'neutral'; label: string } {
  if (isPolling) return { tone: 'info', label: 'syncing' };
  if (!source.enabled) return { tone: 'neutral', label: 'disabled' };
  if (source.lastSyncError) return { tone: 'rejected', label: 'failed' };
  return { tone: 'verified', label: 'enabled' };
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

  const isPolling = !!run && !isTerminalRun(run.status);
  const status = sourceStatusTone(source, isPolling);

  return (
    <tr>
      <td>
        <Link to={`/sources/${source.id}`}>{source.name}</Link>
      </td>
      <td className="cell-sub mono">{source.path}</td>
      <td>
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td className="cell-sub">
        {source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : 'Never synced'}
        {source.lastSyncStatus && <div>{source.lastSyncStatus}</div>}
        {source.lastSyncError && <div>{source.lastSyncError}</div>}
      </td>
      <td className="num">{source.fileCount}</td>
      <td>
        <div className="form-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={toggling}
            onClick={() => void handleToggle()}
          >
            {toggling ? 'Updating…' : source.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button variant="primary" size="sm" disabled={starting} onClick={() => void handleSync()}>
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
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [intervalMs, setIntervalMs] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    listSources({ skip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setSources(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load sources');
      });
  }, [skip]);

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
      // A create always lands on the first page — pushing it onto a later page's array would
      // show it out of order with what a re-fetch of that page would return.
      if (skip === 0) {
        setSources((current) => [created, ...(current ?? [])].slice(0, PAGE_SIZE));
      }
      setCount((current) => current + 1);
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

  const hasPrev = skip > 0;
  const hasNext = skip + PAGE_SIZE < count;

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
          <Field label="Name">
            {(inputProps) => (
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Deal Room Inbox"
                {...inputProps}
              />
            )}
          </Field>
          <Field label="Folder path">
            {(inputProps) => (
              <input
                type="text"
                required
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="deal-room"
                {...inputProps}
              />
            )}
          </Field>
          <Field label="Sync interval (ms, optional)">
            {(inputProps) => (
              <input
                type="number"
                min={1}
                value={intervalMs}
                onChange={(e) => setIntervalMs(e.target.value)}
                placeholder="60000"
                {...inputProps}
              />
            )}
          </Field>
          <div className="form-actions">
            <Button type="submit" disabled={creating}>
              {creating ? 'Adding…' : 'Add source'}
            </Button>
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

      {!sources && !error && <Skeleton label="Loading sources…" />}

      {sources && sources.length === 0 && count === 0 && (
        <EmptyState
          title="No sources yet — add one to start syncing documents."
          description="A source is a watched folder that keeps this data room current. Use the form above to add one."
        />
      )}

      {sources && sources.length > 0 && (
        <section className="panel">
          <Table caption="Sources syncing documents into this data room">
            <thead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Path</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Last sync</TableHeaderCell>
                <TableHeaderCell>Files</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
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
          </Table>
        </section>
      )}

      {sources && (
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hasPrev}
            onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hasNext}
            onClick={() => setSkip((s) => s + PAGE_SIZE)}
          >
            Next
          </Button>
          <span className="cell-sub">{count} total</span>
        </div>
      )}
    </div>
  );
}
