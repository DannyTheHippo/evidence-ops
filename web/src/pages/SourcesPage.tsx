import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  createSource,
  getWorkflowRunById,
  listSources,
  requestSourceSync,
  updateSource,
  type Source,
  type SourceReachability,
  type WorkflowRun,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { RowLink, TableHeaderCell, TableRow } from '../components/ui/Table';
import { notify } from '../components/ui/toast';
import { formatInterval } from '../lib/format-interval';
import { useSession } from '../lib/use-session';
import { isTerminalRun } from '../lib/workflow-runs';

const DEFAULT_POLL_INTERVAL_MS = 1500;
const PAGE_SIZE = 20;

const TRACKED_OPTIONS = [
  { value: 'true', label: 'Synced by a connector' },
  { value: 'false', label: 'Catalogued only' },
];

// live -> verified, possible -> caution (the class is literally badge--possible), prohibited ->
// neutral. Never `rejected` — that octagon is reserved for verification-grade failure, and
// `prohibited` is standing policy an owner chose, not an incident.
function reachTone(reachability: SourceReachability): 'verified' | 'caution' | 'neutral' {
  if (reachability === 'live') return 'verified';
  if (reachability === 'possible') return 'caution';
  return 'neutral';
}

// An in-flight sync outranks everything else the row could report — it supersedes whatever status
// the last completed sync left behind. Disabled is neutral regardless of a carried error, since the
// row is not currently acting on its schedule either way. A carried lastSyncError reads as caution
// once the source is both enabled and idle — a stalled folder sync is a "watch this", not the
// verification-grade rejection the same tone means elsewhere in the app — so it never turns an
// otherwise-healthy list alarming.
function sourceStatusTone(
  source: Source,
  isPolling: boolean,
): { tone: 'verified' | 'caution' | 'rejected' | 'info' | 'neutral'; label: string } {
  if (isPolling) return { tone: 'info', label: 'syncing' };
  if (!source.enabled) return { tone: 'neutral', label: 'disabled' };
  if (source.lastSyncError) return { tone: 'caution', label: 'failed' };
  return { tone: 'verified', label: 'enabled' };
}

function SourceRow({
  source,
  pollIntervalMs,
  canManage,
  onToggled,
}: {
  source: Source;
  pollIntervalMs: number;
  canManage: boolean;
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
      const updated = await updateSource(source.id, { enabled: !source.enabled });
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
    <TableRow to={`/sources/${source.id}`}>
      <td>
        <RowLink to={`/sources/${source.id}`}>{source.name}</RowLink>
      </td>
      <td className="cell-sub mono">{source.path}</td>
      <td>{source.owner ?? <span className="cell-sub">Unassigned</span>}</td>
      <td className="cell-sub">{formatInterval(source.intervalMs)}</td>
      <td>
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td>
        <Badge tone={reachTone(source.reachability)}>{source.reachability}</Badge>
        <div className="cell-sub">{source.connectivity}</div>
      </td>
      <td>{source.sourceClass}</td>
      <td className="cell-sub">
        {source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : 'Never synced'}
        {source.lastSyncStatus && <div>{source.lastSyncStatus}</div>}
        {source.lastSyncError && <div>{source.lastSyncError}</div>}
      </td>
      <td className="num">{source.fileCount}</td>
      <td>
        <div className="form-actions">
          {canManage && (
            <Button
              variant="secondary"
              size="sm"
              disabled={toggling}
              onClick={() => void handleToggle()}
            >
              {toggling ? 'Updating…' : source.enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
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
    </TableRow>
  );
}

// Inventory-only rows carry no sync state at all — no interval, status, last-sync or file count —
// so this stays a separate, narrower row rather than SourceRow with half its cells blank.
function InventoryRow({ source }: { source: Source }) {
  return (
    <TableRow to={`/sources/${source.id}`}>
      <td>
        <RowLink to={`/sources/${source.id}`}>{source.name}</RowLink>
      </td>
      <td className="cell-sub mono">{source.path}</td>
      <td>{source.owner ?? <span className="cell-sub">Unassigned</span>}</td>
      <td>
        <Badge tone={reachTone(source.reachability)}>{source.reachability}</Badge>
        <div className="cell-sub">{source.connectivity}</div>
      </td>
      <td>{source.sourceClass}</td>
    </TableRow>
  );
}

interface SourcesPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

export default function SourcesPage({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: SourcesPageProps) {
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, matching DocumentDetail.tsx's canDelete — a
  // member (or a session that hasn't resolved yet) never sees the create form or a toggle flash in
  // before the check lands. The server's RolesGuard on POST/PATCH /sources is the actual boundary.
  const canManage = session.status === 'authed' && session.me.role === 'admin';
  // The notice states an absence of permission, so it waits for the probe to land — an admin is
  // never told they are not one while the session resolves.
  const sessionResolved = session.status !== 'loading';

  const [trackedSources, setTrackedSources] = useState<Source[] | null>(null);
  const [trackedCount, setTrackedCount] = useState(0);
  const [trackedError, setTrackedError] = useState<string | null>(null);
  const [trackedSkip, setTrackedSkip] = useState(0);

  const [inventorySources, setInventorySources] = useState<Source[] | null>(null);
  const [inventoryCount, setInventoryCount] = useState(0);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventorySkip, setInventorySkip] = useState(0);

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [owner, setOwner] = useState('');
  const [tracked, setTracked] = useState('true');
  const [intervalMs, setIntervalMs] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadTracked = useCallback(() => {
    return listSources({ tracked: true, skip: trackedSkip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setTrackedSources(docs);
        setTrackedCount(total);
        setTrackedError(null);
      })
      .catch((err: unknown) => {
        setTrackedError(err instanceof Error ? err.message : 'Failed to load sources');
      });
  }, [trackedSkip]);

  useEffect(() => {
    void loadTracked();
  }, [loadTracked]);

  const loadInventory = useCallback(() => {
    return listSources({ tracked: false, skip: inventorySkip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setInventorySources(docs);
        setInventoryCount(total);
        setInventoryError(null);
      })
      .catch((err: unknown) => {
        setInventoryError(err instanceof Error ? err.message : 'Failed to load inventory sources');
      });
  }, [inventorySkip]);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createSource({
        name,
        kind: 'local-folder',
        path,
        owner,
        tracked: tracked === 'true',
        intervalMs: intervalMs.trim() ? Number(intervalMs) : undefined,
      });
      // A source created untracked belongs in the inventory list, not the synced one — reload
      // whichever list the new row actually landed in from the server, rather than prepending it
      // optimistically into the wrong one.
      if (created.tracked) {
        if (trackedSkip === 0) void loadTracked();
        else setTrackedSkip(0);
      } else if (inventorySkip === 0) {
        void loadInventory();
      } else {
        setInventorySkip(0);
      }
      notify('success', `Added ${created.name}.`);
      setName('');
      setPath('');
      setOwner('');
      setTracked('true');
      setIntervalMs('');
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create source');
    } finally {
      setCreating(false);
    }
  }

  function handleToggled(updated: Source) {
    setTrackedSources(
      (current) => current?.map((s) => (s.id === updated.id ? updated : s)) ?? current,
    );
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
        {sessionResolved && !canManage && (
          <p className="cell-sub">Adding and configuring sources requires an admin.</p>
        )}
        {canManage && (
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
            <Field label="Owner">
              {(inputProps) => (
                <input
                  type="text"
                  required
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="Jane Doe, IT"
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
            <Select
              label="Tracked"
              options={TRACKED_OPTIONS}
              value={tracked}
              onChange={setTracked}
            />
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
        )}
        {createError && (
          <p className="error" role="alert">
            {createError}
          </p>
        )}
      </section>

      <div className="section-head">
        <h2 className="card-title">Synced sources</h2>
      </div>

      {trackedError && (
        <p className="error error--page" role="alert">
          {trackedError}
        </p>
      )}

      {!trackedSources && !trackedError && <Skeleton label="Loading sources…" />}

      {trackedSources && trackedSources.length === 0 && trackedCount === 0 && (
        <EmptyState
          title="No sources yet — add one to start syncing documents."
          description="A source is a watched folder that keeps this data room current. Use the form above to add one."
        />
      )}

      {trackedSources && trackedSources.length > 0 && (
        <section className="panel">
          <Table caption="Sources syncing documents into this data room">
            <thead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Path</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Interval</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Reach</TableHeaderCell>
                <TableHeaderCell>Class</TableHeaderCell>
                <TableHeaderCell>Last sync</TableHeaderCell>
                <TableHeaderCell>Files</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {trackedSources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  pollIntervalMs={pollIntervalMs}
                  canManage={canManage}
                  onToggled={handleToggled}
                />
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {trackedSources && (
        <Pager
          count={trackedCount}
          skip={trackedSkip}
          pageSize={PAGE_SIZE}
          onSkipChange={setTrackedSkip}
        />
      )}

      <div className="section-head">
        <h2 className="card-title">Inventory</h2>
        <span className="card-meta card-meta--end">Catalogued, never synced.</span>
      </div>

      {inventoryError && (
        <p className="error error--page" role="alert">
          {inventoryError}
        </p>
      )}

      {!inventorySources && !inventoryError && <Skeleton label="Loading inventory…" />}

      {inventorySources && inventorySources.length === 0 && inventoryCount === 0 && (
        <EmptyState
          title="No inventory-only repositories yet."
          description="A repository with no connector still belongs in the estate map — add one and leave it catalogued only."
        />
      )}

      {inventorySources && inventorySources.length > 0 && (
        <section className="panel">
          <Table caption="Repositories catalogued for the estate but never synced">
            <thead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Path</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Reach</TableHeaderCell>
                <TableHeaderCell>Class</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {inventorySources.map((source) => (
                <InventoryRow key={source.id} source={source} />
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {inventorySources && (
        <Pager
          count={inventoryCount}
          skip={inventorySkip}
          pageSize={PAGE_SIZE}
          onSkipChange={setInventorySkip}
        />
      )}
    </div>
  );
}
