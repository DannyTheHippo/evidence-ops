import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  applySourceClassDrift,
  getSourceById,
  getSourceClassDrift,
  updateSource,
  type DocumentSourceClass,
  type SourceClassDrift,
  type SourceConnectivity,
  type SourceReachability,
  type SourceWithFileStates,
} from '../api/client';
import { IconDatabase } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { formatInterval } from '../lib/format-interval';
import { syncRunLabel, useSourceSync } from '../lib/use-source-sync';
import { useSession } from '../lib/use-session';

const CONNECTIVITY_OPTIONS: { value: SourceConnectivity; label: string }[] = [
  { value: 'connector', label: 'Connector' },
  { value: 'export-only', label: 'Export-only' },
  { value: 'manual', label: 'Manual' },
];

const REACHABILITY_OPTIONS: { value: SourceReachability; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'possible', label: 'Possible' },
  { value: 'prohibited', label: 'Prohibited' },
];

const CLASS_OPTIONS: { value: DocumentSourceClass; label: string }[] = [
  { value: 'crm-export', label: 'CRM export' },
  { value: 'pm-export', label: 'PM export' },
  { value: 'spreadsheet', label: 'Spreadsheet' },
  { value: 'memo', label: 'Memo' },
  { value: 'report', label: 'Report' },
  { value: 'unclassified', label: 'Unclassified' },
];

const TRACKED_OPTIONS = [
  { value: 'true', label: 'Synced by a connector' },
  { value: 'false', label: 'Catalogued only' },
];

interface SourceDetailPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers. Forwarded to
  // `useSourceSync`, which supplies the default poll cadence when this is omitted.
  pollIntervalMs?: number;
}

export default function SourceDetailPage({ pollIntervalMs }: SourceDetailPageProps) {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, matching DocumentDetail.tsx's canDelete — a
  // member (or a session that hasn't resolved yet) never sees the enable toggle or the inventory
  // edit form flash in before the check lands. The server's RolesGuard on PATCH /sources/:id is
  // the actual boundary.
  const canManage = session.status === 'authed' && session.me.role === 'admin';
  // The notice states an absence of permission, so it waits for the probe to land — an admin is
  // never told they are not one while the session resolves.
  const sessionResolved = session.status !== 'loading';

  const [source, setSource] = useState<SourceWithFileStates | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const { run, isPolling, starting, syncError, startSync } = useSourceSync(pollIntervalMs);
  const [drift, setDrift] = useState<SourceClassDrift | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [inventoryOwner, setInventoryOwner] = useState('');
  const [inventoryConnectivity, setInventoryConnectivity] =
    useState<SourceConnectivity>('connector');
  const [inventoryReachability, setInventoryReachability] = useState<SourceReachability>('live');
  const [inventoryClass, setInventoryClass] = useState<DocumentSourceClass>('unclassified');
  const [inventoryTracked, setInventoryTracked] = useState('true');
  const [updatingInventory, setUpdatingInventory] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getSourceById(id)
      .then((result) => {
        setSource(result);
        setNotFound(false);
        setError(null);
        // Seeds the editable fields from the server's own values on load — inside the same
        // async callback that sets `source`, not a separate effect keyed on it, so this never
        // trips `react-hooks/set-state-in-effect`'s ban on a synchronous setState in an effect
        // body (an async `.then()` callback is exempt; it never runs during the render pass the
        // rule protects against).
        setInventoryOwner(result.owner ?? '');
        setInventoryConnectivity(result.connectivity);
        setInventoryReachability(result.reachability);
        setInventoryClass(result.sourceClass);
        setInventoryTracked(String(result.tracked));
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load source');
      });
  }, [id]);

  // Reused by the initial load below and by a successful apply, so the card and its count always
  // reflect what the server reports right now rather than a value patched in locally. Returns the
  // `.then()`/`.catch()` chain rather than `await`ing internally — a synchronous `setState` call
  // inside an effect body (which `await`ing here before the first suspension would produce) is
  // itself the thing the effect lint rule below rejects.
  const loadDrift = useCallback((sourceId: string) => {
    return getSourceClassDrift(sourceId)
      .then((result) => {
        setDrift(result);
        setDriftError(null);
      })
      .catch((err: unknown) => {
        setDriftError(err instanceof Error ? err.message : 'Failed to load class drift');
      });
  }, []);

  useEffect(() => {
    if (!id) return;
    void loadDrift(id);
  }, [id, loadDrift]);

  async function handleApplyDrift() {
    if (!source) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applySourceClassDrift(source.id);
      setApplyDialogOpen(false);
      notify(
        'success',
        `Applied ${result.sourceClass} to ${result.modifiedCount} document${
          result.modifiedCount === 1 ? '' : 's'
        }.`,
      );
      await loadDrift(source.id);
    } catch (err: unknown) {
      setApplyError(err instanceof Error ? err.message : 'Failed to apply class drift');
    } finally {
      setApplying(false);
    }
  }

  async function handleToggle() {
    if (!source) return;
    setToggling(true);
    setToggleError(null);
    try {
      const updated = await updateSource(source.id, { enabled: !source.enabled });
      setSource((current) => (current ? { ...current, ...updated } : current));
    } catch (err: unknown) {
      setToggleError(err instanceof Error ? err.message : 'Failed to update source');
    } finally {
      setToggling(false);
    }
  }

  // The card this creates drift, so a successful edit re-runs the drift load in the same handler —
  // otherwise a class change would only surface its own drift card on the next navigation.
  async function handleUpdateInventory(e: FormEvent<HTMLFormElement>) {
    if (!source) return;
    e.preventDefault();
    setUpdatingInventory(true);
    setInventoryError(null);
    try {
      const updated = await updateSource(source.id, {
        owner: inventoryOwner.trim() || undefined,
        connectivity: inventoryConnectivity,
        reachability: inventoryReachability,
        tracked: inventoryTracked === 'true',
        sourceClass: inventoryClass,
      });
      setSource((current) => (current ? { ...current, ...updated } : current));
      notify('success', 'Updated inventory details.');
      await loadDrift(updated.id);
    } catch (err: unknown) {
      setInventoryError(err instanceof Error ? err.message : 'Failed to update inventory details');
    } finally {
      setUpdatingInventory(false);
    }
  }

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
    <div className="view">
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

      {!source && !error && !notFound && id && <Skeleton label="Loading source…" />}

      {source && (
        <>
          {/*
            Leads with health and drift — the state this source is in, and whether it has
            diverged — rather than its filesystem path, which is metadata further down.
          */}
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Sync health</h2>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <p className="cell-sub">
              {source.lastSyncAt ? (
                <>
                  Last synced <Timestamp value={source.lastSyncAt} />
                </>
              ) : (
                'Never synced'
              )}
            </p>
            {source.lastSyncError && (
              <p className="notice notice--warn">Last sync failed: {source.lastSyncError}</p>
            )}
            {drift && (
              <p className="cell-sub">
                {drift.count > 0
                  ? `${drift.count} document${drift.count === 1 ? '' : 's'} pending class drift.`
                  : 'No class drift.'}
              </p>
            )}
            <p className="cell-sub mono">{source.path}</p>
            <p className="cell-sub">{formatInterval(source.intervalMs)}</p>
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
              <Button
                variant="primary"
                size="sm"
                disabled={starting}
                onClick={() => void startSync(source.id, source.name)}
              >
                {starting ? 'Syncing…' : 'Sync now'}
              </Button>
              {run && (
                <Link to={`/workflow-runs/${run.id}`}>
                  {isPolling && <span className="live-dot" />}
                  {syncRunLabel(run)}
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

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Inventory</h2>
            </div>
            {sessionResolved && !canManage && (
              <p className="cell-sub">Editing inventory details requires an admin.</p>
            )}
            {canManage && (
              <form onSubmit={(e) => void handleUpdateInventory(e)} className="form">
                <Field label="Owner">
                  {(inputProps) => (
                    <input
                      type="text"
                      value={inventoryOwner}
                      onChange={(e) => setInventoryOwner(e.target.value)}
                      placeholder="Jane Doe, IT"
                      {...inputProps}
                    />
                  )}
                </Field>
                <Select
                  label="Connectivity"
                  options={CONNECTIVITY_OPTIONS}
                  value={inventoryConnectivity}
                  onChange={(value) => setInventoryConnectivity(value as SourceConnectivity)}
                />
                <Select
                  label="Reachability"
                  options={REACHABILITY_OPTIONS}
                  value={inventoryReachability}
                  onChange={(value) => setInventoryReachability(value as SourceReachability)}
                />
                <Select
                  label="Tracked"
                  options={TRACKED_OPTIONS}
                  value={inventoryTracked}
                  onChange={setInventoryTracked}
                />
                <Select
                  label="Class"
                  options={CLASS_OPTIONS}
                  value={inventoryClass}
                  onChange={(value) => setInventoryClass(value as DocumentSourceClass)}
                />
                <div className="form-actions">
                  <Button type="submit" disabled={updatingInventory}>
                    {updatingInventory ? 'Saving…' : 'Save inventory details'}
                  </Button>
                </div>
              </form>
            )}
            {inventoryError && (
              <p className="error" role="alert">
                {inventoryError}
              </p>
            )}
          </section>

          {driftError && (
            <p className="error" role="alert">
              {driftError}
            </p>
          )}

          {drift && drift.count > 0 && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Class drift</h2>
              </div>
              <p className="notice notice--warn">
                {drift.count} document{drift.count === 1 ? '' : 's'} still carr
                {drift.count === 1 ? 'ies' : 'y'} the previous class ({drift.previousClass}).
              </p>
              {sessionResolved && !canManage && (
                <p className="cell-sub">Applying class drift requires an admin.</p>
              )}
              {canManage && (
                <>
                  <div className="form-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setApplyError(null);
                        setApplyDialogOpen(true);
                      }}
                    >
                      Apply current class to {drift.count} document{drift.count === 1 ? '' : 's'}
                    </Button>
                  </div>
                  <Dialog
                    open={applyDialogOpen}
                    onClose={() => setApplyDialogOpen(false)}
                    title={`Apply current class to ${drift.count} document${
                      drift.count === 1 ? '' : 's'
                    }?`}
                  >
                    <p>
                      {drift.count} document{drift.count === 1 ? '' : 's'} still carr
                      {drift.count === 1 ? 'ies' : 'y'} the previous class ({drift.previousClass}).
                      This applies {source.sourceClass} to every document still carrying{' '}
                      {drift.previousClass} at the moment you confirm — the number actually changed
                      can differ from {drift.count} if a sync completes before then.
                    </p>
                    <div className="form-actions">
                      <Button variant="ghost" onClick={() => setApplyDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        disabled={applying}
                        onClick={() => void handleApplyDrift()}
                      >
                        {applying
                          ? 'Applying…'
                          : `Apply to ${drift.count} document${drift.count === 1 ? '' : 's'}`}
                      </Button>
                    </div>
                    {applyError && (
                      <p className="error" role="alert">
                        {applyError}
                      </p>
                    )}
                  </Dialog>
                </>
              )}
            </section>
          )}

          <section
            className="panel"
            tabIndex={0}
            role="region"
            aria-label="Per-file sync status for this source"
          >
            {source.fileStates.length === 0 ? (
              <EmptyState
                icon={<IconDatabase size={24} />}
                title="No files synced yet"
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
                      <TableCell label="File" className="mono">
                        <span className="cell-truncate" title={fileState.path}>
                          {fileState.path}
                        </span>
                      </TableCell>
                      <TableCell label="Status">
                        <Badge tone={fileState.lastError ? 'rejected' : 'verified'}>
                          {fileState.status}
                        </Badge>
                      </TableCell>
                      <TableCell label="Last error" className="cell-sub">
                        {fileState.lastError ?? '—'}
                      </TableCell>
                      <TableCell label="Last modified" className="cell-sub">
                        <Timestamp value={new Date(fileState.mtimeMs).toISOString()} />
                      </TableCell>
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
