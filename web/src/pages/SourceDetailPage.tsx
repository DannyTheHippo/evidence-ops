import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  applySourceClassDrift,
  getSourceById,
  getSourceClassDrift,
  updateSource,
  type DocumentSourceClass,
  type Source,
  type SourceClassDrift,
  type SourceConnectivity,
  type SourceReachability,
  type SourceWithFileStates,
} from '../api/client';
import { IconDatabase } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import DescriptionList from '../components/ui/DescriptionList';
import EmptyState from '../components/ui/EmptyState';
import ErrorSummary from '../components/ui/ErrorSummary';
import Input from '../components/ui/Input';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import RadioGroup, { type RadioOption } from '../components/ui/RadioGroup';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Stat from '../components/ui/Stat';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { formatInterval } from '../lib/format-interval';
import { useFormSubmit } from '../lib/use-form-submit';
import { syncRunLabel, useSourceSync } from '../lib/use-source-sync';
import { useSession } from '../lib/use-session';

const CONNECTIVITY_OPTIONS: RadioOption[] = [
  {
    value: 'connector',
    label: 'Connector',
    hint: 'This system syncs bytes directly from the source.',
  },
  {
    value: 'export-only',
    label: 'Export-only',
    hint: 'Someone exports files by hand; this system only reads what lands.',
  },
  {
    value: 'manual',
    label: 'Manual',
    hint: 'Nothing syncs automatically — catalogued by hand only.',
  },
];

const REACHABILITY_OPTIONS: RadioOption[] = [
  { value: 'live', label: 'Live', hint: 'This system can reach the source right now.' },
  {
    value: 'possible',
    label: 'Possible',
    hint: 'Reachable in principle, but access is not yet set up.',
  },
  {
    value: 'prohibited',
    label: 'Prohibited',
    hint: 'Policy blocks this system from reaching the source.',
  },
];

const TRACKED_OPTIONS: RadioOption[] = [
  {
    value: 'true',
    label: 'Synced by a connector',
    hint: 'The sync loop may run for this source.',
  },
  {
    value: 'false',
    label: 'Catalogued only',
    hint: 'An inventory record only — the sync loop never runs for it.',
  },
];

const CLASS_OPTIONS: { value: DocumentSourceClass; label: string }[] = [
  { value: 'crm-export', label: 'CRM export' },
  { value: 'pm-export', label: 'PM export' },
  { value: 'spreadsheet', label: 'Spreadsheet' },
  { value: 'memo', label: 'Memo' },
  { value: 'report', label: 'Report' },
  { value: 'unclassified', label: 'Unclassified' },
];

// The DTO property names `updateSource` accepts — not the state variable names, which is what
// lets a server field-validation error land on the right control instead of falling through to
// `formError` unmatched.
type InventoryField = 'owner' | 'connectivity' | 'reachability' | 'tracked' | 'sourceClass';

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
  const [drift, setDrift] = useState<SourceClassDrift | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [owner, setOwner] = useState('');
  const [connectivity, setConnectivity] = useState<SourceConnectivity>('connector');
  const [reachability, setReachability] = useState<SourceReachability>('live');
  const [sourceClass, setSourceClass] = useState<DocumentSourceClass>('unclassified');
  const [tracked, setTracked] = useState('true');

  // Seeds the editable inventory fields from the server's own values — called from the initial
  // load below and again after a successful save, so a trimmed-to-empty owner or a class the
  // server itself normalizes never leaves the form showing something it didn't actually store.
  const seedInventoryFields = useCallback((result: Source) => {
    setOwner(result.owner ?? '');
    setConnectivity(result.connectivity);
    setReachability(result.reachability);
    setSourceClass(result.sourceClass);
    setTracked(String(result.tracked));
  }, []);

  useEffect(() => {
    if (!id) return;
    getSourceById(id)
      .then((result) => {
        setSource(result);
        setNotFound(false);
        setError(null);
        // Inside the same async callback that sets `source`, not a separate effect keyed on it,
        // so this never trips `react-hooks/set-state-in-effect`'s ban on a synchronous setState in
        // an effect body (an async `.then()` callback is exempt; it never runs during the render
        // pass the rule protects against).
        seedInventoryFields(result);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load source');
      });
  }, [id, seedInventoryFields]);

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

  // `useSourceSync`'s `onSettled` fires once a sync run reaches a terminal state, which is the
  // only signal this page gets that `lastSyncAt`/`lastSyncError` or the drift count may have moved
  // — without it, both stay exactly as they were pre-sync until a manual reload. A background
  // refresh's own failure is swallowed rather than replacing an already-rendered source with the
  // initial load's error or not-found UI.
  const reloadAfterSync = useCallback(() => {
    if (!id) return;
    getSourceById(id)
      .then((result) => {
        setSource(result);
        seedInventoryFields(result);
      })
      .catch(() => {
        // Swallowed — see the comment above.
      });
    void loadDrift(id);
  }, [id, loadDrift, seedInventoryFields]);

  const { run, isPolling, starting, syncError, startSync } = useSourceSync(
    pollIntervalMs,
    reloadAfterSync,
  );

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

  // The class this edit sets can itself create drift, so a successful save re-runs the drift load
  // in the same submit — otherwise a class change would only surface its own drift card on the
  // next navigation. `useFormSubmit` supplies the in-flight guard this page otherwise lacks: a
  // second click before the button's own `disabled` re-render lands is a no-op rather than a
  // second concurrent PATCH.
  const {
    pending: updatingInventory,
    formError: inventoryFormError,
    onSubmit: onInventorySubmit,
    fieldProps: inventoryFieldProps,
    // Destructured straight out of `summary` here rather than kept as one object and read via
    // `.ref`/`.errors` in the JSX below — the latter shape trips `react-hooks/refs` (the object
    // carries a ref, so any property read off it downstream reads as a ref access) even though
    // `errors` itself is not one.
    summary: { ref: inventorySummaryRef, errors: inventorySummaryErrors },
  } = useFormSubmit<InventoryField>({
    validate: () => ({}),
    submit: async () => {
      if (!source) return;
      const updated = await updateSource(source.id, {
        owner: owner.trim() || undefined,
        connectivity,
        reachability,
        tracked: tracked === 'true',
        sourceClass,
      });
      setSource((current) => (current ? { ...current, ...updated } : current));
      notify('success', 'Updated inventory details.');
      await loadDrift(updated.id);
      seedInventoryFields(updated);
    },
  });

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
      <PageHeader
        eyebrow="Evidence"
        title={source ? source.name : 'Source'}
        description="Per-file sync state for this source."
        actions={
          <LinkButton to="/sources" variant="secondary" size="sm">
            Back to sources
          </LinkButton>
        }
      />

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
            Leads with health — a Stat row plus, when it applies, the loudest thing on the page —
            rather than the filesystem path or creation date, which are metadata further down.
          */}
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Sync health</h2>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <div className="stat-row">
              <Stat
                label="Last sync"
                value={source.lastSyncAt ? <Timestamp value={source.lastSyncAt} /> : 'Never synced'}
              />
              <Stat label="Cadence" value={formatInterval(source.intervalMs)} />
              <Stat
                label="Pending drift"
                value={drift ? drift.count : '—'}
                tone={drift && drift.count > 0 ? 'caution' : 'neutral'}
              />
              <Stat label="Files" value={source.fileCount} />
            </div>
            {source.lastSyncError && (
              <p className="notice notice--warn">Last sync failed: {source.lastSyncError}</p>
            )}
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

          <DescriptionList
            columns={2}
            items={[
              { term: 'Path', description: <span className="mono cell-sub">{source.path}</span> },
              { term: 'Created', description: <Timestamp value={source.createdAt} /> },
            ]}
          />

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Inventory</h2>
            </div>
            {sessionResolved && !canManage && (
              <p className="cell-sub">Editing inventory details requires an admin.</p>
            )}
            {canManage && (
              <form onSubmit={onInventorySubmit} className="form" noValidate>
                <ErrorSummary
                  ref={inventorySummaryRef}
                  errors={inventorySummaryErrors}
                  formError={inventoryFormError ?? undefined}
                />
                <Input
                  {...inventoryFieldProps('owner')}
                  label="Owner"
                  optional
                  value={owner}
                  onChange={setOwner}
                  placeholder="Jane Doe, IT"
                />
                <RadioGroup
                  {...inventoryFieldProps('connectivity')}
                  legend="Connectivity"
                  options={CONNECTIVITY_OPTIONS}
                  value={connectivity}
                  onChange={(value) => setConnectivity(value as SourceConnectivity)}
                />
                <RadioGroup
                  {...inventoryFieldProps('reachability')}
                  legend="Reachability"
                  options={REACHABILITY_OPTIONS}
                  value={reachability}
                  onChange={(value) => setReachability(value as SourceReachability)}
                />
                <RadioGroup
                  {...inventoryFieldProps('tracked')}
                  legend="Tracked"
                  options={TRACKED_OPTIONS}
                  value={tracked}
                  onChange={setTracked}
                />
                <Select
                  {...inventoryFieldProps('sourceClass')}
                  label="Class"
                  options={CLASS_OPTIONS}
                  value={sourceClass}
                  onChange={(value) => setSourceClass(value as DocumentSourceClass)}
                />
                <div className="form-actions">
                  <Button type="submit" disabled={updatingInventory}>
                    {updatingInventory ? 'Saving…' : 'Save inventory details'}
                  </Button>
                </div>
              </form>
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
              <DescriptionList
                columns={2}
                items={[
                  {
                    term: 'Previous → Current class',
                    description: `${drift.previousClass} → ${source.sourceClass}`,
                  },
                  {
                    term: 'Documents affected',
                    description: `${drift.count} document${drift.count === 1 ? '' : 's'} still carr${
                      drift.count === 1 ? 'ies' : 'y'
                    } the previous class (${drift.previousClass}).`,
                  },
                ]}
              />
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
                  <ConfirmDialog
                    open={applyDialogOpen}
                    onClose={() => setApplyDialogOpen(false)}
                    title={`Apply current class to ${drift.count} document${
                      drift.count === 1 ? '' : 's'
                    }?`}
                    body={`${drift.count} document${drift.count === 1 ? '' : 's'} still carr${
                      drift.count === 1 ? 'ies' : 'y'
                    } the previous class (${drift.previousClass}). This applies ${
                      source.sourceClass
                    } to every document still carrying ${
                      drift.previousClass
                    } at the moment you confirm — the number actually changed can differ from ${
                      drift.count
                    } if a sync completes before then.`}
                    confirmLabel={`Apply to ${drift.count} document${drift.count === 1 ? '' : 's'}`}
                    destructive
                    busy={applying}
                    error={applyError ?? undefined}
                    onConfirm={() => void handleApplyDrift()}
                  />
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
