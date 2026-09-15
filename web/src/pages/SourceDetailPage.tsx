import { useCallback, useRef, useState } from 'react';
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
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import CopyButton from '../components/ui/CopyButton';
import DescriptionList from '../components/ui/DescriptionList';
import EmptyState from '../components/ui/EmptyState';
import ErrorSummary from '../components/ui/ErrorSummary';
import Input from '../components/ui/Input';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Panel from '../components/ui/Panel';
import RadioGroup from '../components/ui/RadioGroup';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Stat from '../components/ui/Stat';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import { notify } from '../components/ui/toast';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { formatInterval } from '../lib/format-interval';
import { useAbortableEffect } from '../lib/use-latest';
import {
  CLASS_OPTIONS,
  CONNECTIVITY_OPTIONS,
  REACHABILITY_OPTIONS,
  SOURCE_KIND_LABELS,
  TRACKED_OPTIONS,
  sourceClassLabel,
} from '../lib/source-options';
import { sourceStatus } from '../lib/source-status';
import { useFormSubmit } from '../lib/use-form-submit';
import { syncRunLabel, useSourceSync } from '../lib/use-source-sync';
import { useSession } from '../lib/use-session';

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

  // Bumped by the load effect below on every id change. reloadAfterSync and the mutation handlers
  // (handleToggle, the inventory submit, handleApplyDrift) run outside that effect — as a
  // useSourceSync callback or a click handler — so none of them can reuse its isCurrent() closure.
  // Each captures this ref's value before its own await and checks it again once its fetch
  // resolves, dropping a result for an id the user has since navigated away from: reloadAfterSync
  // and loadDrift drop their fetched source/drift instead of rendering over the current one;
  // handleToggle and handleApplyDrift drop their own error; the inventory submit's rejection is
  // rethrown only when the sequence still matches, so a stale one never reaches useFormSubmit's own
  // catch and never shows an error or moves focus on the source now shown; both success toasts (the
  // inventory save and the drift apply) and the drift dialog's close are skipped the same way; and
  // handleToggle's and handleApplyDrift's own `finally` clears `toggling`/`applying` only when the
  // sequence still matches, so a stale settle never flips off a flag the load effect below has
  // already reset for the new source.
  const loadSequenceRef = useRef(0);
  // Receives focus when a confirmed drift apply removes the drift card and the button that opened
  // its dialog, when that button held focus at open. The per-file panel it points at is the drift
  // card's next sibling, so it takes the card's place in the layout once the card unmounts. The
  // panel root rather than a heading inside it: the panel holds no heading, and its region name is
  // what a screen reader announces on focus.
  const fileStatesPanelRef = useRef<HTMLElement | null>(null);

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

  // Resets state first, matching DocumentDetail.tsx's shape, so a route change from one source to
  // another never leaves the previous source's fields on screen while the new one loads. Guarded
  // by isCurrent() rather than relying on React Router to remount the page across ids, since
  // RequireAuth renders this element unkeyed and the same instance survives the navigation.
  useAbortableEffect(
    (isCurrent) => {
      if (!id) return;
      loadSequenceRef.current += 1;
      setSource(null);
      setNotFound(false);
      setError(null);
      setDrift(null);
      setDriftError(null);
      setToggling(false);
      setToggleError(null);
      setApplyDialogOpen(false);
      setApplying(false);
      setApplyError(null);

      getSourceById(id)
        .then((result) => {
          if (!isCurrent()) return;
          setSource(result);
          seedInventoryFields(result);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
            return;
          }
          setError(err instanceof Error ? err.message : 'Failed to load source');
        });

      getSourceClassDrift(id)
        .then((result) => {
          if (!isCurrent()) return;
          setDrift(result);
          setDriftError(null);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setDriftError(err instanceof Error ? err.message : 'Failed to load class drift');
        });
    },
    [id, seedInventoryFields],
  );

  useBreadcrumbs([
    { label: 'Sources', to: '/sources' },
    { label: source ? source.name : 'Source' },
  ]);

  // Reused by a successful apply and the inventory save, so the card and its count always
  // reflect what the server reports right now rather than a value patched in locally. Returns the
  // `.then()`/`.catch()` chain rather than `await`ing internally — a synchronous `setState` call
  // inside an effect body (which `await`ing here before the first suspension would produce) is
  // itself the thing the effect lint rule below rejects.
  const loadDrift = useCallback((sourceId: string, sequence: number) => {
    return getSourceClassDrift(sourceId)
      .then((result) => {
        if (sequence !== loadSequenceRef.current) return;
        setDrift(result);
        setDriftError(null);
      })
      .catch((err: unknown) => {
        if (sequence !== loadSequenceRef.current) return;
        setDriftError(err instanceof Error ? err.message : 'Failed to load class drift');
      });
  }, []);

  // `useSourceSync`'s `onSettled` fires once the sweep it started settles — the source's own
  // `lastSyncAt` has advanced past the request time — which is the only signal this page gets that
  // `lastSyncAt`/`lastSyncError` or the drift count may have moved; without it, both stay exactly
  // as they were pre-sync until a manual reload. The sync loop's own run rarely reaches a terminal
  // status on its own (`syncRunLabel` exists for that), so `onSettled` never waits on it. A
  // background refresh's own failure is swallowed rather than replacing an already-rendered source
  // with the initial load's error or not-found UI. Guarded by `loadSequenceRef`, captured before
  // either fetch starts, so a response that lands after the id has since moved on is dropped
  // instead of rendering the wrong source or seeding its inventory form with it.
  const reloadAfterSync = useCallback(() => {
    if (!id) return;
    const sequence = loadSequenceRef.current;
    getSourceById(id)
      .then((result) => {
        if (sequence !== loadSequenceRef.current) return;
        setSource(result);
        seedInventoryFields(result);
      })
      .catch(() => {
        // Swallowed — see the comment above.
      });
    getSourceClassDrift(id)
      .then((result) => {
        if (sequence !== loadSequenceRef.current) return;
        setDrift(result);
        setDriftError(null);
      })
      .catch((err: unknown) => {
        if (sequence !== loadSequenceRef.current) return;
        setDriftError(err instanceof Error ? err.message : 'Failed to load class drift');
      });
  }, [id, seedInventoryFields]);

  const { run, isPolling, starting, syncError, startSync } = useSourceSync(
    pollIntervalMs,
    reloadAfterSync,
  );

  async function handleApplyDrift() {
    if (!source) return;
    setApplying(true);
    setApplyError(null);
    const sequence = loadSequenceRef.current;
    try {
      const result = await applySourceClassDrift(source.id);
      if (sequence === loadSequenceRef.current) {
        notify(
          'success',
          `Applied ${sourceClassLabel(result.sourceClass)} to ${result.modifiedCount} document${
            result.modifiedCount === 1 ? '' : 's'
          }.`,
        );
      }
      await loadDrift(source.id, sequence);
      // Closed after the re-fetched count is set, so both updates commit together: a count of 0
      // unmounts the drift card with its opener and this dialog in one commit, so the dialog's
      // focus restore, when the Apply button held focus at open, finds that button detached and
      // moves focus to the per-file panel that follows the card. A pointer-opened dialog that
      // recorded `body` leaves focus where the browser put it.
      if (sequence === loadSequenceRef.current) setApplyDialogOpen(false);
    } catch (err: unknown) {
      if (sequence === loadSequenceRef.current) {
        setApplyError(err instanceof Error ? err.message : 'Failed to apply class drift');
      }
    } finally {
      if (sequence === loadSequenceRef.current) setApplying(false);
    }
  }

  async function handleToggle() {
    if (!source) return;
    setToggling(true);
    setToggleError(null);
    const sequence = loadSequenceRef.current;
    try {
      const updated = await updateSource(source.id, { enabled: !source.enabled });
      if (sequence === loadSequenceRef.current) {
        setSource((current) => (current ? { ...current, ...updated } : current));
      }
    } catch (err: unknown) {
      if (sequence === loadSequenceRef.current) {
        setToggleError(err instanceof Error ? err.message : 'Failed to update source');
      }
    } finally {
      if (sequence === loadSequenceRef.current) setToggling(false);
    }
  }

  // The class this edit sets can itself create drift, so a successful save re-runs the drift load
  // in the same submit — otherwise a class change would only surface its own drift card on the
  // next navigation. `useFormSubmit` supplies the in-flight guard: the busy Save button stays
  // enabled so it keeps focus, and a busy submit button still submits its form, so a second
  // submit while the PATCH is pending is a no-op there rather than a second concurrent PATCH.
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
      const sequence = loadSequenceRef.current;
      let updated: Source;
      try {
        updated = await updateSource(source.id, {
          owner: owner.trim() === '' ? null : owner.trim(),
          connectivity,
          reachability,
          tracked: tracked === 'true',
          sourceClass,
        });
      } catch (err: unknown) {
        // A rejection for a source the user has since navigated away from is dropped here, before
        // it can reach useFormSubmit's own catch and show its error on the page now shown.
        if (sequence !== loadSequenceRef.current) return;
        throw err;
      }
      if (sequence === loadSequenceRef.current) {
        setSource((current) => (current ? { ...current, ...updated } : current));
        notify('success', 'Updated inventory details.');
      }
      await loadDrift(updated.id, sequence);
      if (sequence === loadSequenceRef.current) {
        seedInventoryFields(updated);
      }
    },
  });

  // Computed unconditionally (not inside the `source &&` JSX guard below) since a `const` cannot
  // be declared inside a JSX expression — `status` is only ever read once `source` is truthy.
  const status = source ? sourceStatus(source, isPolling) : null;
  // The class-drift card only renders while `drift.count > 0`, which the server guarantees
  // carries a `previousClass` — computed once here rather than asserted at each of its four uses
  // below.
  const previousClassLabel = drift?.previousClass ? sourceClassLabel(drift.previousClass) : null;
  const noSyncLoop = status?.key === 'mcp-submit' || status?.key === 'untracked';
  const lastSyncValue = source?.lastSync?.finishedAt ?? source?.lastSyncAt;
  const syncErrorDetail = source?.lastSync?.error ?? source?.lastSyncError;

  return (
    <div className="view">
      <PageHeader
        eyebrow="Estate"
        title={source ? source.name : 'Source'}
        description="Per-file sync state for this source."
        actions={
          <LinkButton to="/sources" variant="secondary" size="sm">
            Back to sources
          </LinkButton>
        }
      />

      {error && <Alert tone="rejected">{error}</Alert>}

      {!id && <Alert tone="rejected">No source id provided.</Alert>}

      {notFound && <p className="notice notice--info">Source not found.</p>}

      {!source && !error && !notFound && id && <Skeleton label="Loading source…" />}

      {source && status && (
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
              {!noSyncLoop && (
                <>
                  <Stat
                    label="Last sync"
                    kind="text"
                    value={lastSyncValue ? <Timestamp value={lastSyncValue} /> : 'Never synced'}
                  />
                  <Stat
                    label="Next sweep"
                    kind="text"
                    value={
                      source.lastSync?.nextSweepAt ? (
                        <Timestamp value={source.lastSync.nextSweepAt} />
                      ) : (
                        'Not scheduled'
                      )
                    }
                  />
                  <Stat label="Cadence" kind="text" value={formatInterval(source.intervalMs)} />
                </>
              )}
              <Stat
                label="Pending drift"
                value={drift ? drift.count : '—'}
                tone={drift && drift.count > 0 ? 'caution' : 'neutral'}
              />
              <Stat label="Files" value={source.fileCount} />
            </div>
            {driftError && <Alert tone="caution">{driftError}</Alert>}
            {noSyncLoop ? (
              <Alert tone={status.tone}>{status.detail}</Alert>
            ) : (
              <>
                {syncErrorDetail && (
                  <Alert tone="caution">Last sync failed: {syncErrorDetail}</Alert>
                )}
                <div className="form-actions">
                  {canManage && (
                    <Button
                      variant="secondary"
                      size="sm"
                      busy={toggling}
                      busyLabel="Saving…"
                      aria-label={source.enabled ? 'Disable' : 'Enable'}
                      onClick={() => void handleToggle()}
                    >
                      {source.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                  {status.key !== 'disabled' && (
                    <Button
                      variant="primary"
                      size="sm"
                      busy={starting}
                      busyLabel="Syncing…"
                      aria-label="Sync now"
                      onClick={() => void startSync(source.id, source.name)}
                    >
                      Sync now
                    </Button>
                  )}
                  {run && (
                    <Link to={`/workflow-runs/${run.id}`}>
                      {isPolling && <span className="live-dot" />}
                      {syncRunLabel(run)}
                    </Link>
                  )}
                </div>
                {toggleError && <Alert tone="rejected">{toggleError}</Alert>}
                {syncError && <Alert tone="rejected">{syncError}</Alert>}
              </>
            )}
          </section>

          <DescriptionList
            columns={2}
            items={[
              { term: 'Kind', description: SOURCE_KIND_LABELS[source.kind] },
              {
                term: source.kind === 'mcp-submit' ? 'Submitting client' : 'Path',
                description: <span className="mono cell-sub">{source.path}</span>,
              },
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
                  <Button
                    type="submit"
                    busy={updatingInventory}
                    busyLabel="Saving…"
                    aria-label="Save inventory details"
                  >
                    Save inventory details
                  </Button>
                </div>
              </form>
            )}
          </section>

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
                    description: `${previousClassLabel} → ${sourceClassLabel(source.sourceClass)}`,
                  },
                  {
                    term: 'Documents affected',
                    description: `${drift.count} document${drift.count === 1 ? '' : 's'} still carr${
                      drift.count === 1 ? 'ies' : 'y'
                    } the previous class (${previousClassLabel}).`,
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
                    } the previous class (${previousClassLabel}). This applies ${sourceClassLabel(
                      source.sourceClass,
                    )} to every document still carrying ${previousClassLabel} at the moment you confirm — the number actually changed can differ from ${
                      drift.count
                    } if a sync completes before then.`}
                    confirmLabel={`Apply to ${drift.count} document${drift.count === 1 ? '' : 's'}`}
                    destructive
                    busy={applying}
                    error={applyError ?? undefined}
                    fallbackFocusRef={fileStatesPanelRef}
                    onConfirm={() => void handleApplyDrift()}
                  />
                </>
              )}
            </section>
          )}

          <Panel ref={fileStatesPanelRef} aria-label="Per-file sync status for this source">
            {source.fileStates.length === 0 ? (
              <EmptyState
                icon={<IconDatabase size={24} />}
                title="No files synced yet"
                description="File status appears here after the source's next sync."
              />
            ) : (
              <Table caption="Per-file sync status for this source" className="source-detail-grid">
                <colgroup>
                  <col />
                  <col className="col-badge" />
                  <col className="col-wide" />
                  <col className="col-compact" />
                </colgroup>
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
                        <div className="cell-truncate-action">
                          <Tooltip content={fileState.path}>
                            <span className="cell-truncate" tabIndex={0}>
                              {fileState.path}
                            </span>
                          </Tooltip>
                          <CopyButton text={fileState.path} label="Copy path" />
                        </div>
                      </TableCell>
                      <TableCell label="Status">
                        <Badge tone={fileState.lastError ? 'rejected' : 'verified'}>
                          {fileState.status}
                        </Badge>
                      </TableCell>
                      <TableCell label="Last error" className="cell-sub">
                        {fileState.lastError ? (
                          <Tooltip content={fileState.lastError}>
                            <span className="cell-truncate" tabIndex={0}>
                              {fileState.lastError}
                            </span>
                          </Tooltip>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell label="Last modified" className="cell-sub">
                        <Timestamp value={new Date(fileState.mtimeMs).toISOString()} />
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
