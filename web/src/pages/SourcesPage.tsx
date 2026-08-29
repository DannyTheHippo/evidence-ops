import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  createSource,
  listSources,
  updateSource,
  type Source,
  type SourceReachability,
  type SourceSortField,
  type SortDirection,
} from '../api/client';
import { IconDatabase } from '../components/icons';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import ErrorSummary from '../components/ui/ErrorSummary';
import FilterBar from '../components/ui/FilterBar';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import PageHeader from '../components/ui/PageHeader';
import RadioGroup from '../components/ui/RadioGroup';
import SegmentedControl from '../components/ui/SegmentedControl';
import Skeleton from '../components/ui/Skeleton';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import Toolbar from '../components/ui/Toolbar';
import { notify } from '../components/ui/toast';
import { useFormSubmit } from '../lib/use-form-submit';
import { formatInterval } from '../lib/format-interval';
import { syncRunLabel, useSourceSync } from '../lib/use-source-sync';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 20;

const TRACKED_OPTIONS = [
  { value: 'true', label: 'Synced by a connector' },
  { value: 'false', label: 'Catalogued only' },
];

type SourceView = 'tracked' | 'inventory';

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both. Typed as
// plain `string` fields, not `as const` literals, so the values written back through
// `setUrlState` — themselves unions like `SourceSortField` — stay assignable. Two skip keys, not
// one: this page runs two independently paginated lists behind a single switch, and each list
// keeps its own page position while the other is off screen.
const URL_DEFAULTS: Record<'view' | 'q' | 'sort' | 'sortDir' | 'skip' | 'invSkip', string> = {
  view: 'tracked',
  q: '',
  sort: 'name',
  sortDir: 'asc',
  skip: '0',
  invSkip: '0',
};

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
function sourceStatusTone(source: Source, isPolling: boolean): { tone: BadgeTone; label: string } {
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
  pollIntervalMs: number | undefined;
  canManage: boolean;
  onToggled: (updated: Source) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const { run, isPolling, starting, syncError, startSync } = useSourceSync(pollIntervalMs);

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

  const status = sourceStatusTone(source, isPolling);

  return (
    <TableRow to={`/sources/${source.id}`}>
      <TableCell label="Name">
        <RowLink to={`/sources/${source.id}`}>{source.name}</RowLink>
        <div className="cell-sub mono">
          <span className="cell-truncate" title={source.path}>
            {source.path}
          </span>
        </div>
      </TableCell>
      <TableCell label="Owner">
        {source.owner ?? <span className="cell-sub">Unassigned</span>}
      </TableCell>
      <TableCell label="Status">
        <Badge tone={status.tone}>{status.label}</Badge>
        {source.lastSyncError && <div className="cell-sub">{source.lastSyncError}</div>}
      </TableCell>
      <TableCell label="Reach">
        <Badge tone={reachTone(source.reachability)}>{source.reachability}</Badge>
        <div className="cell-sub">
          {source.connectivity} · {source.sourceClass}
        </div>
      </TableCell>
      <TableCell label="Last sync" className="cell-sub">
        {source.lastSyncAt ? <Timestamp value={source.lastSyncAt} /> : 'Never synced'}
        <div>{formatInterval(source.intervalMs)}</div>
      </TableCell>
      <TableCell label="Created" className="cell-sub">
        <Timestamp value={source.createdAt} />
      </TableCell>
      <TableCell label="Files" className="num">
        {source.fileCount}
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
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
      </TableCell>
    </TableRow>
  );
}

// Inventory-only rows carry no sync state at all — no status, last-sync or file count — so this
// stays a separate, narrower row rather than SourceRow with half its cells blank. Class stays its
// own column here, unlike the tracked table's Reach sub-line, because nothing else on this row
// competes with it for space.
function InventoryRow({ source }: { source: Source }) {
  return (
    <TableRow to={`/sources/${source.id}`}>
      <TableCell label="Name">
        <RowLink to={`/sources/${source.id}`}>{source.name}</RowLink>
        <div className="cell-sub mono">
          <span className="cell-truncate" title={source.path}>
            {source.path}
          </span>
        </div>
      </TableCell>
      <TableCell label="Owner">
        {source.owner ?? <span className="cell-sub">Unassigned</span>}
      </TableCell>
      <TableCell label="Reach">
        <Badge tone={reachTone(source.reachability)}>{source.reachability}</Badge>
        <div className="cell-sub">{source.connectivity}</div>
      </TableCell>
      <TableCell label="Class">{source.sourceClass}</TableCell>
      <TableCell label="Created" className="cell-sub">
        <Timestamp value={source.createdAt} />
      </TableCell>
    </TableRow>
  );
}

type CreateSourceField = 'name' | 'owner' | 'path' | 'tracked' | 'intervalMs';

interface CreateSourceDialogProps {
  onClose: () => void;
  // Runs once the source is created, before the dialog closes — the caller reloads whichever list
  // the new row landed in and switches the view to it.
  onCreated: (created: Source) => void;
}

/** Create-only authoring surface for one source, always open — its parent mounts it only while
 * the dialog is open, so each open starts fresh rather than replaying a prior open's values or
 * server error. Field names are the `createSource` DTO's own property names, which is what lets a
 * server field error land on the right control. */
function CreateSourceDialog({ onClose, onCreated }: CreateSourceDialogProps) {
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [path, setPath] = useState('');
  const [tracked, setTracked] = useState('true');
  const [intervalMs, setIntervalMs] = useState('');

  function validate(): Partial<Record<CreateSourceField, string>> {
    const errors: Partial<Record<CreateSourceField, string>> = {};
    if (!name.trim()) errors.name = 'Name is required.';
    if (!owner.trim()) errors.owner = 'Owner is required.';
    if (!path.trim()) errors.path = 'Folder path is required.';
    if (tracked === 'true' && intervalMs.trim()) {
      const parsed = Number(intervalMs);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.intervalMs = 'Enter a sync interval greater than zero.';
      }
    }
    return errors;
  }

  async function submit() {
    const created = await createSource({
      name: name.trim(),
      kind: 'local-folder',
      path: path.trim(),
      owner: owner.trim(),
      tracked: tracked === 'true',
      intervalMs: tracked === 'true' && intervalMs.trim() ? Number(intervalMs) : undefined,
    });
    notify('success', `Added ${created.name}.`);
    onCreated(created);
  }

  // The create route documents exactly one 409: the unique {tenantId, name} index
  // (sources.service.ts's `create`) — a domain exception, not a field-validation error, so it never
  // arrives through `ApiError.fields`. Naming it on `name` here is what makes the field itself, not
  // just a page-level message, tell a caller which value collided.
  function mapServerError(err: ApiError): Partial<Record<CreateSourceField, string>> | null {
    return err.status === 409 ? { name: err.message } : null;
  }

  const {
    pending,
    formError,
    onSubmit,
    fieldProps,
    // Destructured here rather than passed on as `summary.ref`/`summary.errors` below — a plain
    // identifier reads unambiguously as a ref, where a member expression on a hook-returned object
    // does not.
    summary: { ref: summaryRef, errors: summaryErrors },
  } = useFormSubmit<CreateSourceField>({
    validate,
    submit,
    mapServerError,
    onSuccess: onClose,
  });

  // Called in the form's visual order — `fieldProps` registers each name the first time it runs,
  // and that registration order is what `summary`/focus-on-failure walk, so calling it out of
  // visual order here would list or focus fields in an order the form doesn't render them in.
  const nameField = fieldProps('name');
  const ownerField = fieldProps('owner');
  const pathField = fieldProps('path');
  const trackedField = fieldProps('tracked');
  const intervalField = fieldProps('intervalMs');

  return (
    <Dialog open onClose={onClose} title="New source" size="md">
      <form onSubmit={onSubmit} className="form" noValidate>
        <ErrorSummary ref={summaryRef} errors={summaryErrors} formError={formError ?? undefined} />
        <Input
          {...nameField}
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Deal Room Inbox"
        />
        <Input
          {...ownerField}
          label="Owner"
          value={owner}
          onChange={setOwner}
          placeholder="Jane Doe, IT"
        />
        <Input
          {...pathField}
          label="Folder path"
          value={path}
          onChange={setPath}
          placeholder="deal-room"
        />
        <RadioGroup
          id={trackedField.id}
          legend="Tracked"
          error={trackedField.error}
          onBlur={trackedField.onBlur}
          options={TRACKED_OPTIONS}
          value={tracked}
          onChange={setTracked}
        />
        {tracked === 'true' && (
          <Input
            {...intervalField}
            label="Sync interval (ms)"
            optional
            type="number"
            min={1}
            value={intervalMs}
            onChange={setIntervalMs}
            placeholder="60000"
          />
        )}
        <div className="form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Adding…' : 'Add source'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// The status a switchable list is in — loading, blank (an error with nothing to show yet), empty,
// or ready — mirroring `RecordListStatus`'s shape by hand, since this page renders one of two such
// regions depending on `view` rather than the single region `RecordListPage` provides.
type ListStatus =
  | { kind: 'loading'; label: string }
  | { kind: 'blank' }
  | { kind: 'empty'; title: string; description: string }
  | { kind: 'ready' };

interface SourcesPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers. Forwarded to
  // `useSourceSync`, which supplies the default poll cadence when this is omitted.
  pollIntervalMs?: number;
}

export default function SourcesPage({ pollIntervalMs }: SourcesPageProps) {
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, matching DocumentDetail.tsx's canDelete — a
  // member (or a session that hasn't resolved yet) never sees the "New source" action or a toggle
  // flash in before the check lands. The server's RolesGuard on POST/PATCH /sources is the actual
  // boundary.
  const canManage = session.status === 'authed' && session.me.role === 'admin';

  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const view = urlState.view as SourceView;
  const appliedQ = urlState.q;
  const sort = urlState.sort as SourceSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const trackedSkip = Number(urlState.skip);
  const inventorySkip = Number(urlState.invSkip);

  // Only this, not the search input's own value, drives a fetch — search applies on submit, not on
  // every keystroke, matching every other list page's filter bar.
  const [draftQ, setDraftQ] = useState(appliedQ);

  const [trackedSources, setTrackedSources] = useState<Source[] | null>(null);
  const [trackedCount, setTrackedCount] = useState(0);
  const [trackedError, setTrackedError] = useState<string | null>(null);

  const [inventorySources, setInventorySources] = useState<Source[] | null>(null);
  const [inventoryCount, setInventoryCount] = useState(0);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);

  // Both lists load regardless of which one is on screen — a create reloads whichever list the new
  // source actually lands in, and that logic stays correct only if both stay live rather than one
  // going stale while it is switched away from.
  const loadTracked = useCallback(() => {
    return listSources({
      tracked: true,
      skip: trackedSkip,
      limit: PAGE_SIZE,
      sort,
      sortDir,
      q: appliedQ || undefined,
    })
      .then(({ docs, count: total }) => {
        setTrackedSources(docs);
        setTrackedCount(total);
        setTrackedError(null);
      })
      .catch((err: unknown) => {
        setTrackedError(err instanceof Error ? err.message : 'Failed to load sources');
      });
  }, [trackedSkip, sort, sortDir, appliedQ]);

  useEffect(() => {
    void loadTracked();
  }, [loadTracked]);

  const loadInventory = useCallback(() => {
    return listSources({
      tracked: false,
      skip: inventorySkip,
      limit: PAGE_SIZE,
      sort,
      sortDir,
      q: appliedQ || undefined,
    })
      .then(({ docs, count: total }) => {
        setInventorySources(docs);
        setInventoryCount(total);
        setInventoryError(null);
      })
      .catch((err: unknown) => {
        setInventoryError(err instanceof Error ? err.message : 'Failed to load inventory sources');
      });
  }, [inventorySkip, sort, sortDir, appliedQ]);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  function handleCreated(created: Source) {
    // A source created untracked belongs in the inventory list, not the synced one — switch the
    // page to whichever list the new row actually landed in and reload it from the server, rather
    // than prepending it optimistically into the wrong one.
    if (created.tracked) {
      if (trackedSkip === 0) void loadTracked();
      setUrlState({ view: 'tracked', skip: URL_DEFAULTS.skip });
    } else {
      if (inventorySkip === 0) void loadInventory();
      setUrlState({ view: 'inventory', invSkip: URL_DEFAULTS.invSkip });
    }
  }

  function handleToggled(updated: Source) {
    setTrackedSources(
      (current) => current?.map((s) => (s.id === updated.id ? updated : s)) ?? current,
    );
  }

  function handleSwitchView(nextView: SourceView) {
    if (nextView === view) return;
    const patch: Partial<typeof urlState> = { view: nextView };
    // `lastSyncAt` has no column on the inventory table — an untracked source is never synced, so
    // the value is always absent there. Carrying that sort across the switch would leave a column
    // header claiming a direction for a column that isn't rendered.
    if (nextView === 'inventory' && sort === 'lastSyncAt') {
      patch.sort = URL_DEFAULTS.sort;
      patch.sortDir = URL_DEFAULTS.sortDir;
    }
    setUrlState(patch);
  }

  function handleSort(field: SourceSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction. A per-field default direction would make a URL written by one column
    // read back with the wrong direction once shared or reloaded, since `useUrlState` carries
    // exactly one default `sortDir` for every field.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    const patch: Partial<typeof urlState> = { sort: field, sortDir: nextDir };
    if (view === 'tracked') patch.skip = URL_DEFAULTS.skip;
    else patch.invSkip = URL_DEFAULTS.invSkip;
    setUrlState(patch);
  }

  function handleApplySearch() {
    setUrlState({ q: draftQ, skip: URL_DEFAULTS.skip, invSkip: URL_DEFAULTS.invSkip });
  }

  function handleClearSearch() {
    setDraftQ('');
    setUrlState({ q: '', skip: URL_DEFAULTS.skip, invSkip: URL_DEFAULTS.invSkip });
  }

  const hasFilter = appliedQ !== '';
  const activeSources = view === 'tracked' ? trackedSources : inventorySources;
  const activeCount = view === 'tracked' ? trackedCount : inventoryCount;
  const activeError = view === 'tracked' ? trackedError : inventoryError;
  const activeSkip = view === 'tracked' ? trackedSkip : inventorySkip;

  let status: ListStatus;
  if (activeSources === null) {
    status = activeError
      ? { kind: 'blank' }
      : { kind: 'loading', label: view === 'tracked' ? 'Loading sources…' : 'Loading inventory…' };
  } else if (activeSources.length === 0) {
    status = hasFilter
      ? {
          kind: 'empty',
          title:
            view === 'tracked'
              ? 'No sources match your search'
              : 'No repositories match your search',
          description: 'Clear or adjust the search above.',
        }
      : {
          kind: 'empty',
          title: view === 'tracked' ? 'No sources yet' : 'No inventory-only repositories yet',
          description:
            view === 'tracked'
              ? 'A source is a watched folder that keeps this data room current — add one with New source.'
              : 'A repository with no connector still belongs in the estate map — add one with New source and leave it catalogued only.',
        };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <div className="view">
      <PageHeader
        eyebrow="Evidence"
        title="Sources"
        description="Point at a folder and watch it sync documents in."
        actions={
          canManage && (
            <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
              New source
            </Button>
          )
        }
      />

      {createOpen && (
        <CreateSourceDialog onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
      )}

      <Toolbar
        start={
          <>
            <div className="sources-segmented">
              <SegmentedControl<SourceView>
                aria-label="Source list"
                options={[
                  { value: 'tracked', label: 'Tracked sources', count: trackedCount },
                  { value: 'inventory', label: 'Repository inventory', count: inventoryCount },
                ]}
                value={view}
                onChange={handleSwitchView}
              />
            </div>
            <FilterBar
              onApply={handleApplySearch}
              onClear={handleClearSearch}
              hasFilter={hasFilter}
            >
              <Input
                label="Search"
                value={draftQ}
                onChange={setDraftQ}
                placeholder="Name, path or owner"
              />
            </FilterBar>
          </>
        }
      />

      {activeError && (
        <p className="error error--page" role="alert">
          {activeError}
        </p>
      )}

      {status.kind === 'loading' && <Skeleton label={status.label} />}

      {status.kind === 'empty' && (
        <EmptyState
          icon={<IconDatabase size={24} />}
          title={status.title}
          description={status.description}
        />
      )}

      {status.kind === 'ready' && activeSources && view === 'tracked' && (
        <section
          className="panel"
          tabIndex={0}
          role="region"
          aria-label="Sources syncing documents into this data room"
        >
          <Table caption="Sources syncing documents into this data room">
            <thead>
              <tr>
                <SortableHeaderCell<SourceSortField>
                  field="name"
                  label="Name"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<SourceSortField>
                  field="owner"
                  label="Owner"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Reach</TableHeaderCell>
                <SortableHeaderCell<SourceSortField>
                  field="lastSyncAt"
                  label="Last sync"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<SourceSortField>
                  field="createdAt"
                  label="Created"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Files</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {activeSources.map((source) => (
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

      {status.kind === 'ready' && activeSources && view === 'inventory' && (
        <section
          className="panel"
          tabIndex={0}
          role="region"
          aria-label="Repositories catalogued for the estate but never synced"
        >
          <Table caption="Repositories catalogued for the estate but never synced">
            <thead>
              <tr>
                <SortableHeaderCell<SourceSortField>
                  field="name"
                  label="Name"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<SourceSortField>
                  field="owner"
                  label="Owner"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Reach</TableHeaderCell>
                <TableHeaderCell>Class</TableHeaderCell>
                <SortableHeaderCell<SourceSortField>
                  field="createdAt"
                  label="Created"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
              </tr>
            </thead>
            <tbody>
              {activeSources.map((source) => (
                <InventoryRow key={source.id} source={source} />
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {activeSources && (
        <Pager
          count={activeCount}
          skip={activeSkip}
          pageSize={PAGE_SIZE}
          onSkipChange={(next) =>
            setUrlState(view === 'tracked' ? { skip: String(next) } : { invSkip: String(next) })
          }
        />
      )}
    </div>
  );
}
