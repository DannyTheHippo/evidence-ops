import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
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
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import FilterBar from '../components/ui/FilterBar';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
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

// Client-side only: `ListSourcesRequestDto` has no free-text parameter, so this filters whatever
// page is already on screen rather than the whole list — the `Pager`'s count still reflects the
// server total for that reason.
function matchesSearch(source: Source, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    source.name.toLowerCase().includes(q) ||
    source.path.toLowerCase().includes(q) ||
    (source.owner ?? '').toLowerCase().includes(q)
  );
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
      </TableCell>
      <TableCell label="Path" className="cell-sub mono">
        <span className="cell-truncate" title={source.path}>
          {source.path}
        </span>
      </TableCell>
      <TableCell label="Owner">
        {source.owner ?? <span className="cell-sub">Unassigned</span>}
      </TableCell>
      <TableCell label="Interval" className="cell-sub">
        {formatInterval(source.intervalMs)}
      </TableCell>
      <TableCell label="Status">
        <Badge tone={status.tone}>{status.label}</Badge>
      </TableCell>
      <TableCell label="Reach">
        <Badge tone={reachTone(source.reachability)}>{source.reachability}</Badge>
        <div className="cell-sub">{source.connectivity}</div>
      </TableCell>
      <TableCell label="Class">{source.sourceClass}</TableCell>
      <TableCell label="Last sync" className="cell-sub">
        {source.lastSyncAt ? <Timestamp value={source.lastSyncAt} /> : 'Never synced'}
        {source.lastSyncStatus && <div>{source.lastSyncStatus}</div>}
        {source.lastSyncError && <div>{source.lastSyncError}</div>}
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

// Inventory-only rows carry no sync state at all — no interval, status, last-sync or file count —
// so this stays a separate, narrower row rather than SourceRow with half its cells blank.
function InventoryRow({ source }: { source: Source }) {
  return (
    <TableRow to={`/sources/${source.id}`}>
      <TableCell label="Name">
        <RowLink to={`/sources/${source.id}`}>{source.name}</RowLink>
      </TableCell>
      <TableCell label="Path" className="cell-sub mono">
        <span className="cell-truncate" title={source.path}>
          {source.path}
        </span>
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
  // member (or a session that hasn't resolved yet) never sees the create form or a toggle flash in
  // before the check lands. The server's RolesGuard on POST/PATCH /sources is the actual boundary.
  const canManage = session.status === 'authed' && session.me.role === 'admin';
  // The notice states an absence of permission, so it waits for the probe to land — an admin is
  // never told they are not one while the session resolves.
  const sessionResolved = session.status !== 'loading';

  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const view = urlState.view as SourceView;
  const appliedQ = urlState.q;
  const sort = urlState.sort as SourceSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const trackedSkip = Number(urlState.skip);
  const inventorySkip = Number(urlState.invSkip);

  // Only this, not the search input's own value, drives the client-side filter — search applies
  // on submit, not on every keystroke, matching every other list page's filter bar.
  const [draftQ, setDraftQ] = useState(appliedQ);

  const [trackedSources, setTrackedSources] = useState<Source[] | null>(null);
  const [trackedCount, setTrackedCount] = useState(0);
  const [trackedError, setTrackedError] = useState<string | null>(null);

  const [inventorySources, setInventorySources] = useState<Source[] | null>(null);
  const [inventoryCount, setInventoryCount] = useState(0);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [owner, setOwner] = useState('');
  const [tracked, setTracked] = useState('true');
  const [intervalMs, setIntervalMs] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // A name conflict names the Name field specifically (the unique {tenantId, name} index behind
  // it), so it renders on that field rather than in the page-level createError below.
  const [nameError, setNameError] = useState<string | null>(null);
  // Blocks a double submit between the click and the re-render that disables the submit button —
  // `disabled={creating}` alone only takes effect once React has committed it.
  const createInFlightRef = useRef(false);

  // Both lists load regardless of which one is on screen — the create form below reloads
  // whichever list a new source actually lands in, and that logic stays correct only if both
  // stay live rather than one going stale while it is switched away from.
  const loadTracked = useCallback(() => {
    return listSources({ tracked: true, skip: trackedSkip, limit: PAGE_SIZE, sort, sortDir })
      .then(({ docs, count: total }) => {
        setTrackedSources(docs);
        setTrackedCount(total);
        setTrackedError(null);
      })
      .catch((err: unknown) => {
        setTrackedError(err instanceof Error ? err.message : 'Failed to load sources');
      });
  }, [trackedSkip, sort, sortDir]);

  useEffect(() => {
    void loadTracked();
  }, [loadTracked]);

  const loadInventory = useCallback(() => {
    return listSources({ tracked: false, skip: inventorySkip, limit: PAGE_SIZE, sort, sortDir })
      .then(({ docs, count: total }) => {
        setInventorySources(docs);
        setInventoryCount(total);
        setInventoryError(null);
      })
      .catch((err: unknown) => {
        setInventoryError(err instanceof Error ? err.message : 'Failed to load inventory sources');
      });
  }, [inventorySkip, sort, sortDir]);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    setCreating(true);
    setCreateError(null);
    setNameError(null);
    try {
      const created = await createSource({
        name,
        kind: 'local-folder',
        path,
        owner,
        tracked: tracked === 'true',
        intervalMs: intervalMs.trim() ? Number(intervalMs) : undefined,
      });
      // A source created untracked belongs in the inventory list, not the synced one — switch the
      // page to whichever list the new row actually landed in and reload it from the server,
      // rather than prepending it optimistically into the wrong one.
      if (created.tracked) {
        if (trackedSkip === 0) void loadTracked();
        setUrlState({ view: 'tracked', skip: URL_DEFAULTS.skip });
      } else {
        if (inventorySkip === 0) void loadInventory();
        setUrlState({ view: 'inventory', invSkip: URL_DEFAULTS.invSkip });
      }
      notify('success', `Added ${created.name}.`);
      setName('');
      setPath('');
      setOwner('');
      setTracked('true');
      setIntervalMs('');
    } catch (err: unknown) {
      // The create route documents exactly one 409: the unique {tenantId, name} index
      // (sources.service.ts's `create`) — every other failure (validation, auth, transport, 500)
      // stays page-level, since nothing else here identifies a single field.
      if (err instanceof ApiError && err.status === 409) {
        setNameError(err.message);
      } else {
        setCreateError(err instanceof Error ? err.message : 'Failed to create source');
      }
    } finally {
      setCreating(false);
      createInFlightRef.current = false;
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
  const filteredSources =
    activeSources?.filter((source) => matchesSearch(source, appliedQ)) ?? null;

  let status: ListStatus;
  if (activeSources === null) {
    status = activeError
      ? { kind: 'blank' }
      : { kind: 'loading', label: view === 'tracked' ? 'Loading sources…' : 'Loading inventory…' };
  } else if (filteredSources && filteredSources.length === 0) {
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
              ? 'A source is a watched folder that keeps this data room current — use the form above to add one.'
              : 'A repository with no connector still belongs in the estate map — add one and leave it catalogued only.',
        };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <div className="view">
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
            <Field label="Name" error={nameError ?? undefined}>
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

      {/*
        Two independently paginated lists behind one switch, not `RecordListPage` — that scaffold
        carries exactly one status region and one footer, and this page needs one of each per list
        rather than stacking both lists' regions on screen at once.
      */}
      <div className="control-row" role="group" aria-label="Source list">
        <Button
          type="button"
          variant={view === 'tracked' ? 'primary' : 'secondary'}
          aria-pressed={view === 'tracked'}
          onClick={() => handleSwitchView('tracked')}
        >
          Tracked sources
        </Button>
        <Button
          type="button"
          variant={view === 'inventory' ? 'primary' : 'secondary'}
          aria-pressed={view === 'inventory'}
          onClick={() => handleSwitchView('inventory')}
        >
          Repository inventory
        </Button>
      </div>

      <FilterBar onApply={handleApplySearch} onClear={handleClearSearch} hasFilter={hasFilter}>
        <Input
          label="Search"
          value={draftQ}
          onChange={setDraftQ}
          placeholder="Name, path or owner"
        />
      </FilterBar>

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

      {status.kind === 'ready' && filteredSources && view === 'tracked' && (
        <section className="panel">
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
                <TableHeaderCell>Path</TableHeaderCell>
                <SortableHeaderCell<SourceSortField>
                  field="owner"
                  label="Owner"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Interval</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Reach</TableHeaderCell>
                <TableHeaderCell>Class</TableHeaderCell>
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
              {filteredSources.map((source) => (
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

      {status.kind === 'ready' && filteredSources && view === 'inventory' && (
        <section className="panel">
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
                <TableHeaderCell>Path</TableHeaderCell>
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
              {filteredSources.map((source) => (
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
