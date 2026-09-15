import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  createSource,
  listSources,
  updateSource,
  type DocumentSourceClass,
  type Source,
  type SourceConnectivity,
  type SourceReachability,
  type SourceSortField,
  type SortDirection,
} from '../api/client';
import { IconDatabase } from '../components/icons';
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Checkbox from '../components/ui/Checkbox';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import ErrorSummary from '../components/ui/ErrorSummary';
import FilterBar from '../components/ui/FilterBar';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import PageHeader from '../components/ui/PageHeader';
import Panel from '../components/ui/Panel';
import RadioGroup from '../components/ui/RadioGroup';
import SearchInput from '../components/ui/SearchInput';
import SegmentedControl from '../components/ui/SegmentedControl';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import Toolbar from '../components/ui/Toolbar';
import Tooltip from '../components/ui/Tooltip';
import { notify } from '../components/ui/toast';
import { useFormSubmit } from '../lib/use-form-submit';
import { formatInterval } from '../lib/format-interval';
import {
  CLASS_OPTIONS,
  CONNECTIVITY_OPTIONS,
  REACHABILITY_OPTIONS,
  TRACKED_OPTIONS,
} from '../lib/source-options';
import { sourceStatus } from '../lib/source-status';
import { syncRunLabel, useSourceSync } from '../lib/use-source-sync';
import { useAbortableEffect, useLatest } from '../lib/use-latest';
import { useDebouncedApply } from '../lib/use-debounced-apply';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { useResultAnnouncer } from '../lib/use-result-announcer';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';

type SourceView = 'tracked' | 'inventory';

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both. Typed as
// plain `string` fields, not `as const` literals, so the values written back through
// `setUrlState` — themselves unions like `SourceSortField` — stay assignable. Two skip keys, not
// one: this page runs two independently paginated lists behind a single switch, and each list
// keeps its own page position while the other is off screen.
const URL_DEFAULTS: Record<
  'view' | 'q' | 'sort' | 'sortDir' | 'skip' | 'invSkip' | 'failed' | 'limit',
  string
> = {
  view: 'tracked',
  q: '',
  sort: 'name',
  sortDir: 'asc',
  skip: '0',
  invSkip: '0',
  failed: '',
  limit: '25',
};

// Matches the server's `@IsIn` list in `list-sources.request.dto.ts` — every field is valid in
// both views; only `handleSwitchView` steers `lastSyncAt` away from the inventory view, which has
// no column for it.
const SORT_FIELDS: readonly SourceSortField[] = ['name', 'owner', 'lastSyncAt', 'createdAt'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

// live -> verified, possible -> caution (the class is literally badge--possible), prohibited ->
// neutral. Never `rejected` — that octagon is reserved for verification-grade failure, and
// `prohibited` is standing policy an owner chose, not an incident.
function reachTone(reachability: SourceReachability): 'verified' | 'caution' | 'neutral' {
  if (reachability === 'live') return 'verified';
  if (reachability === 'possible') return 'caution';
  return 'neutral';
}

function SourceRow({
  source,
  pollIntervalMs,
  canManage,
  onToggled,
  onSettled,
}: {
  source: Source;
  pollIntervalMs: number | undefined;
  canManage: boolean;
  onToggled: (updated: Source) => void;
  onSettled: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const { run, isPolling, starting, syncError, sweepState, startSync } = useSourceSync(
    pollIntervalMs,
    onSettled,
  );

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

  const status = sourceStatus(source, isPolling);
  // The tracked list only ever requests `tracked: true`, so `untracked` cannot reach this row in
  // practice — checked anyway because the gating rule is one predicate shared with the detail
  // page, not a case this row is known to see.
  const noSyncLoop = status.key === 'mcp-submit' || status.key === 'untracked';

  return (
    <TableRow to={`/sources/${source.id}`}>
      <TableCell label="Name">
        <Tooltip content={source.name}>
          <RowLink to={`/sources/${source.id}`}>
            <span className="cell-truncate">{source.name}</span>
          </RowLink>
        </Tooltip>
        <div className="cell-sub mono">
          <Tooltip content={source.path}>
            <span className="cell-truncate" tabIndex={0}>
              {source.path}
            </span>
          </Tooltip>
        </div>
      </TableCell>
      <TableCell label="Owner">
        {source.owner ? (
          <Tooltip content={source.owner}>
            <span className="cell-truncate" tabIndex={0}>
              {source.owner}
            </span>
          </Tooltip>
        ) : (
          <span className="cell-sub">Unassigned</span>
        )}
      </TableCell>
      <TableCell label="Status">
        <Badge tone={status.tone}>{status.label}</Badge>
        {status.detail && (
          <div className="cell-sub">
            <Tooltip content={status.detail}>
              <span className="cell-truncate" tabIndex={0}>
                {status.detail}
              </span>
            </Tooltip>
          </div>
        )}
      </TableCell>
      <TableCell label="Reachability">
        <Badge tone={reachTone(source.reachability)}>{source.reachability}</Badge>
        <div className="cell-sub">
          <Tooltip content={`${source.connectivity} · ${source.sourceClass}`}>
            <span className="cell-truncate" tabIndex={0}>
              {source.connectivity} · {source.sourceClass}
            </span>
          </Tooltip>
        </div>
      </TableCell>
      <TableCell label="Last sync" className="cell-sub">
        <span className="cell-truncate">
          {source.lastSyncAt ? <Timestamp value={source.lastSyncAt} /> : 'Never synced'}
        </span>
        <div className="cell-truncate">{formatInterval(source.intervalMs)}</div>
      </TableCell>
      <TableCell label="Created" className="cell-sub">
        <span className="cell-truncate">
          <Timestamp value={source.createdAt} />
        </span>
      </TableCell>
      <TableCell label="Files" className="cell-numeric">
        {source.fileCount}
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        <div className="form-actions">
          {noSyncLoop ? (
            <span className="cell-sub">{status.detail}</span>
          ) : (
            <>
              {canManage && (
                <Button
                  variant="secondary"
                  size="sm"
                  busy={toggling}
                  busyLabel="Saving…"
                  aria-label={
                    status.key === 'disabled' ? `Enable ${source.name}` : `Disable ${source.name}`
                  }
                  onClick={() => void handleToggle()}
                >
                  {status.key === 'disabled' ? 'Enable' : 'Disable'}
                </Button>
              )}
              {status.key !== 'disabled' && (
                <Button
                  variant="primary"
                  size="sm"
                  busy={starting}
                  busyLabel="Syncing…"
                  aria-label={`Sync now, ${source.name}`}
                  onClick={() => void startSync(source.id, source.name)}
                >
                  Sync now
                </Button>
              )}
            </>
          )}
          {run && (
            <Link to={`/workflow-runs/${run.id}`}>
              {isPolling && <span className="live-dot" />}
              {syncRunLabel(run)}
            </Link>
          )}
          {sweepState === 'timed-out' && (
            <span className="sources-sweep-note">Still sweeping — the loop keeps running</span>
          )}
        </div>
        {toggleError && <Alert tone="rejected">{toggleError}</Alert>}
        {syncError && <Alert tone="rejected">{syncError}</Alert>}
      </TableCell>
    </TableRow>
  );
}

// Inventory-only rows carry no sync state at all — no status, last-sync or file count — so this
// stays a separate, narrower row rather than SourceRow with half its cells blank. Class stays its
// own column here, unlike the tracked table's Reachability sub-line, because nothing else on this row
// competes with it for space.
function InventoryRow({ source }: { source: Source }) {
  return (
    <TableRow to={`/sources/${source.id}`}>
      <TableCell label="Name">
        <Tooltip content={source.name}>
          <RowLink to={`/sources/${source.id}`}>
            <span className="cell-truncate">{source.name}</span>
          </RowLink>
        </Tooltip>
        <div className="cell-sub mono">
          <Tooltip content={source.path}>
            <span className="cell-truncate" tabIndex={0}>
              {source.path}
            </span>
          </Tooltip>
        </div>
      </TableCell>
      <TableCell label="Owner">
        {source.owner ?? <span className="cell-sub">Unassigned</span>}
      </TableCell>
      <TableCell label="Reachability">
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

type CreateSourceField =
  | 'name'
  | 'owner'
  | 'path'
  | 'tracked'
  | 'intervalMs'
  | 'connectivity'
  | 'reachability'
  | 'sourceClass';

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
  const [intervalMinutes, setIntervalMinutes] = useState('');
  const [connectivity, setConnectivity] = useState<SourceConnectivity>('connector');
  const [reachability, setReachability] = useState<SourceReachability>('live');
  const [sourceClass, setSourceClass] = useState<DocumentSourceClass>('unclassified');

  // A catalogued-only source has nothing connecting to it, so it defaults away from the
  // connector/live posture meant for a synced one rather than inheriting it silently; either
  // radio still opens to a manual override.
  function handleTrackedChange(value: string) {
    setTracked(value);
    if (value === 'false') {
      setConnectivity('manual');
      setReachability('possible');
    } else {
      setConnectivity('connector');
      setReachability('live');
    }
  }

  function validate(): Partial<Record<CreateSourceField, string>> {
    const errors: Partial<Record<CreateSourceField, string>> = {};
    if (!name.trim()) errors.name = 'Name is required.';
    if (!owner.trim()) errors.owner = 'Owner is required.';
    if (!path.trim()) errors.path = 'Folder path is required.';
    if (tracked === 'true' && intervalMinutes.trim()) {
      const parsed = Number(intervalMinutes);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        errors.intervalMs = 'Enter a whole number of minutes, greater than zero.';
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
      intervalMs:
        tracked === 'true' && intervalMinutes.trim() ? Number(intervalMinutes) * 60_000 : undefined,
      connectivity,
      reachability,
      sourceClass,
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
  const connectivityField = fieldProps('connectivity');
  const reachabilityField = fieldProps('reachability');
  const sourceClassField = fieldProps('sourceClass');

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
          hint="Relative to the server's configured inbox directory."
          value={path}
          onChange={setPath}
          placeholder="deal-room"
        />
        <RadioGroup
          {...trackedField}
          legend="Tracked"
          options={TRACKED_OPTIONS}
          value={tracked}
          onChange={handleTrackedChange}
        />
        {tracked === 'true' && (
          <Input
            {...intervalField}
            label="Sync interval (minutes)"
            optional
            width="sm"
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={setIntervalMinutes}
            placeholder="5"
          />
        )}
        <RadioGroup
          {...connectivityField}
          legend="Connectivity"
          options={CONNECTIVITY_OPTIONS}
          value={connectivity}
          onChange={(value) => setConnectivity(value as SourceConnectivity)}
        />
        <RadioGroup
          {...reachabilityField}
          legend="Reachability"
          options={REACHABILITY_OPTIONS}
          value={reachability}
          onChange={(value) => setReachability(value as SourceReachability)}
        />
        <Select
          {...sourceClassField}
          label="Class"
          options={CLASS_OPTIONS}
          value={sourceClass}
          onChange={(value) => setSourceClass(value as DocumentSourceClass)}
        />
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
  const sessionResolved = session.status !== 'loading';

  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const view = urlState.view as SourceView;
  const appliedQ = urlState.q;
  const failedOnly = urlState.failed === '1';
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'name');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'asc');
  const trackedSkip = clampSkip(urlState.skip);
  const inventorySkip = clampSkip(urlState.invSkip);
  const pageSize = clampPageSize(urlState.limit, [25, 50, 100], 25);

  // Writes q only when it actually changed, so a flush that repeats the already-applied value
  // (Enter on an unchanged draft, or the clear control on an empty field) never resets paging a
  // second time.
  function applyQuery(value: string) {
    if (value === appliedQ) return;
    setUrlState({ q: value, skip: URL_DEFAULTS.skip, invSkip: URL_DEFAULTS.invSkip });
  }
  const search = useDebouncedApply(appliedQ, applyQuery);
  const announceResult = useResultAnnouncer();
  // Read inside each fetch's own success handler below, rather than closed over at effect-run
  // time — neither effect lists `view` as a dependency, so its own closure would still hold
  // whichever view was active when the fetch started, not the one the response actually lands
  // under.
  const latestView = useLatest(view);

  const [trackedSources, setTrackedSources] = useState<Source[] | null>(null);
  const [trackedCount, setTrackedCount] = useState(0);
  const [trackedError, setTrackedError] = useState<string | null>(null);

  const [inventorySources, setInventorySources] = useState<Source[] | null>(null);
  const [inventoryCount, setInventoryCount] = useState(0);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);

  // Bumped by a create and by a row's own settled sweep — the one signal that forces both list
  // fetches below to run again even when none of their other dependencies changed.
  const [reloadKey, setReloadKey] = useState(0);

  // Both lists load regardless of which one is on screen — a create (or a row's settled sweep)
  // reloads whichever list the affected row actually lives in, and that logic stays correct only
  // if both stay live rather than one going stale while it is switched away from.
  useAbortableEffect(
    (isCurrent) => {
      listSources({
        tracked: true,
        skip: trackedSkip,
        limit: pageSize,
        sort,
        sortDir,
        q: appliedQ || undefined,
        lastSyncStatus: failedOnly ? 'failed' : undefined,
      })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setTrackedSources(docs);
          setTrackedCount(total);
          setTrackedError(null);
          if (latestView.current === 'tracked') {
            announceResult(
              JSON.stringify({ view: 'tracked', q: appliedQ, failed: failedOnly }),
              `${total} ${total === 1 ? 'source' : 'sources'}`,
            );
          }
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setTrackedError(err instanceof Error ? err.message : 'Failed to load sources');
        });
    },
    [trackedSkip, sort, sortDir, appliedQ, failedOnly, pageSize, reloadKey],
  );

  useAbortableEffect(
    (isCurrent) => {
      listSources({
        tracked: false,
        skip: inventorySkip,
        limit: pageSize,
        sort,
        sortDir,
        q: appliedQ || undefined,
      })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setInventorySources(docs);
          setInventoryCount(total);
          setInventoryError(null);
          if (latestView.current === 'inventory') {
            announceResult(
              JSON.stringify({ view: 'inventory', q: appliedQ }),
              `${total} ${total === 1 ? 'repository' : 'repositories'}`,
            );
          }
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setInventoryError(
            err instanceof Error ? err.message : 'Failed to load inventory sources',
          );
        });
    },
    [inventorySkip, sort, sortDir, appliedQ, pageSize, reloadKey],
  );

  function handleCreated(created: Source) {
    // A source created untracked belongs in the inventory list, not the synced one — switch the
    // page to whichever list the new row actually landed in. The reload key bump is what actually
    // re-fetches both lists; it covers the case where the target view's skip was already 0 and a
    // URL-state change alone would not have re-run its effect. An applied search is cleared too,
    // or the new row could land outside the very filter that was in place when it was created —
    // `search.reset` clears the draft directly, since `q` may already read back empty and leave no
    // applied change for the debounced draft to re-sync from.
    search.reset(URL_DEFAULTS.q);
    if (created.tracked) {
      setUrlState({ view: 'tracked', skip: URL_DEFAULTS.skip, q: URL_DEFAULTS.q });
    } else {
      setUrlState({ view: 'inventory', invSkip: URL_DEFAULTS.invSkip, q: URL_DEFAULTS.q });
    }
    setReloadKey((k) => k + 1);
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

  function handleFailedOnlyChange(checked: boolean) {
    setUrlState({ failed: checked ? '1' : '', skip: URL_DEFAULTS.skip });
  }

  // `search.reset` clears the draft and its armed timer directly: `q` may already read back
  // empty, leaving no applied change for the draft to re-sync from.
  function handleClearSearch() {
    search.reset(URL_DEFAULTS.q);
    setUrlState({ q: '', failed: '', skip: URL_DEFAULTS.skip, invSkip: URL_DEFAULTS.invSkip });
  }

  function handlePageSizeChange(nextPageSize: number) {
    setUrlState({
      limit: String(nextPageSize),
      skip: URL_DEFAULTS.skip,
      invSkip: URL_DEFAULTS.invSkip,
    });
  }

  // `failedOnly` has no effect on the inventory list (`listSources` never receives it there, and
  // its checkbox is hidden in that view), so it counts toward `hasFilter` only for the tracked
  // view — otherwise switching to inventory with it still applied would offer Clear filters, and
  // read an empty result as filtered, with no filter actually in effect on that list.
  const hasFilter = appliedQ !== '' || (view === 'tracked' && failedOnly);
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
    // Names only the filter(s) actually in effect on the view shown — the inventory list ignores
    // `failedOnly` entirely, and the tracked view names it only when it, not the search, is why
    // the list came back empty.
    const trackedFilterLabel = [
      appliedQ !== '' ? 'search' : null,
      failedOnly ? 'Failed only filter' : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' or ');
    status = hasFilter
      ? {
          kind: 'empty',
          title:
            view === 'tracked'
              ? `No sources match your ${trackedFilterLabel}`
              : 'No repositories match your search',
          description:
            view === 'tracked'
              ? `Clear or adjust the ${trackedFilterLabel} above.`
              : 'Clear or adjust the search above.',
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
        eyebrow="Estate"
        title="Sources"
        description="Point at a folder and watch it sync documents in, or catalogue a repository the estate knows about without connecting one."
        actions={
          canManage ? (
            <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
              New source
            </Button>
          ) : (
            sessionResolved && (
              <p className="cell-sub">Adding or enabling a source requires an admin.</p>
            )
          )
        }
      />

      {createOpen && (
        <CreateSourceDialog onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
      )}

      <Toolbar
        view={
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
        }
        filters={
          <FilterBar label="Source filters" onClear={handleClearSearch} hasFilter={hasFilter}>
            <SearchInput
              label="Search"
              width="grow"
              value={search.draft}
              onChange={search.setDraft}
              onSearch={search.flush}
              placeholder="Name, path or owner"
            />
            {view === 'tracked' && (
              <Checkbox
                label="Failed only"
                checked={failedOnly}
                onChange={handleFailedOnlyChange}
              />
            )}
          </FilterBar>
        }
      />

      {activeError && (
        <p className="error error--page" role="alert">
          {activeError}
        </p>
      )}

      {status.kind === 'loading' && <Skeleton label={status.label} variant="table" />}

      {status.kind === 'empty' && (
        <EmptyState
          icon={<IconDatabase size={24} />}
          title={status.title}
          description={status.description}
        />
      )}

      {status.kind === 'ready' && activeSources && view === 'tracked' && (
        <Panel aria-label="Sources syncing documents into this data room">
          <Table caption="Sources syncing documents into this data room" className="sources-grid">
            <colgroup>
              <col />
              <col className="col-thin" />
              <col className="col-wide" />
              <col className="col-compact" />
              <col className="col-snug" />
              <col className="col-slim" />
              <col className="col-tiny" />
              <col className="col-badge" />
            </colgroup>
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
                <TableHeaderCell>Reachability</TableHeaderCell>
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
                  onSettled={() => setReloadKey((k) => k + 1)}
                />
              ))}
            </tbody>
          </Table>
        </Panel>
      )}

      {status.kind === 'ready' && activeSources && view === 'inventory' && (
        <Panel aria-label="Repositories catalogued for the estate but never synced">
          <Table
            caption="Repositories catalogued for the estate but never synced"
            className="sources-grid--inventory"
          >
            <colgroup>
              <col />
              <col className="col-compact" />
              <col className="col-compact" />
              <col className="col-compact" />
              <col className="col-narrow" />
            </colgroup>
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
                <TableHeaderCell>Reachability</TableHeaderCell>
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
        </Panel>
      )}

      {activeSources && (
        <Pager
          count={activeCount}
          skip={activeSkip}
          pageSize={pageSize}
          onSkipChange={(next) =>
            setUrlState(view === 'tracked' ? { skip: String(next) } : { invSkip: String(next) })
          }
          onPageSizeChange={handlePageSizeChange}
        />
      )}
    </div>
  );
}
