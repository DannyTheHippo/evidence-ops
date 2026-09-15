import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listAuditEvents,
  listUsers,
  type AuditEventOrigin,
  type AuditEventSortField,
  type AuditEventSubject,
  type AuditEventView,
  type SortDirection,
} from '../api/client';
import { IconClipboard, IconSearch } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import CopyButton from '../components/ui/CopyButton';
import DateRange from '../components/ui/DateRange';
import EmptyState from '../components/ui/EmptyState';
import FilterBar from '../components/ui/FilterBar';
import IconButton from '../components/ui/IconButton';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import SearchInput from '../components/ui/SearchInput';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import {
  DATE_RANGE_OPTIONS,
  dateRangeKey,
  isDateRangeActive,
  readDateRange,
  toDateRangeInstants,
  writeDateRange,
} from '../lib/date-range';
import { shortId } from '../lib/identifiers';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { useDebouncedApply } from '../lib/use-debounced-apply';
import { useAbortableEffect } from '../lib/use-latest';
import { useResultAnnouncer } from '../lib/use-result-announcer';
import { useUrlState } from '../lib/use-url-state';

const ENTITY_ID_FIELD_ID = 'audit-entity-id';
const ENTITY_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const ENTITY_ID_ERROR = 'Enter a 24-character id, or use the search icon beside a subject below.';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Matches the server's `@IsIn` list in `list-audit-events.request.dto.ts`.
const SORT_FIELDS: readonly AuditEventSortField[] = ['createdAt', 'action', 'origin'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

// The subject types that carry a detail route the SPA actually renders. ApiKey, Approval,
// Conflict and User have no per-id page, and DocumentVersion has no route at all (the SPA reads
// versions through their owning document) — those four render as plain text below.
const ENTITY_ROUTE_BASE: Partial<Record<string, string>> = {
  Answer: '/answers',
  Document: '/documents',
  Source: '/sources',
  WorkflowRun: '/workflow-runs',
};

// `subject.entityType` carries no schema-level enum — every audit-emitting service call site
// (api-keys, approvals, audit-events, conflicts, documents, qa, retrieval, sources,
// workflow-runs, auth, the resolve-conflict/ingest-document-version workflows, mcp-server) writes
// one of these string literals, so this is the bounded set the filter can actually match.
const ENTITY_TYPES = [
  'Answer',
  'ApiKey',
  'Approval',
  'Conflict',
  'Document',
  'DocumentVersion',
  'Source',
  'User',
  'WorkflowRun',
];

const ENTITY_TYPE_OPTIONS = [
  { value: '', label: 'All entity types' },
  ...ENTITY_TYPES.map((entityType) => ({ value: entityType, label: entityType })),
];

const ORIGIN_OPTIONS = [
  { value: '', label: 'All origins' },
  { value: 'api', label: 'API' },
  { value: 'mcp', label: 'MCP' },
];

// Mirrors ToolExecutorService's own closed set of refusal reasons
// (src/features/platform/authz/tool-executor.service.ts) — the only values `refusalReason` ever
// takes, so the filter can enumerate them rather than accepting free text.
const REFUSAL_REASON_OPTIONS = [
  { value: '', label: 'All refusal reasons' },
  { value: 'tool-not-registered', label: 'tool-not-registered' },
  { value: 'tool-not-allowed-for-step', label: 'tool-not-allowed-for-step' },
  { value: 'authz-denied', label: 'authz-denied' },
  { value: 'authz-hook-error', label: 'authz-hook-error' },
  { value: 'invalid-arguments', label: 'invalid-arguments' },
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both.
const URL_DEFAULTS: Record<
  | 'action'
  | 'entityType'
  | 'entityId'
  | 'origin'
  | 'refusalReason'
  | 'range'
  | 'from'
  | 'to'
  | 'sort'
  | 'sortDir'
  | 'skip'
  | 'limit',
  string
> = {
  action: '',
  entityType: '',
  entityId: '',
  origin: '',
  refusalReason: '',
  range: '',
  from: '',
  to: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
  limit: '25',
};

// The keys a chip can remove — every filter URL_DEFAULTS carries except sort/sortDir/skip/limit,
// which no chip ever touches. `recorded` clears `range`, `from` and `to` together, as one chip.
type FilterKey = 'action' | 'entityType' | 'entityId' | 'origin' | 'refusalReason' | 'recorded';

function originLabel(origin: AuditEventOrigin | ''): string {
  return ORIGIN_OPTIONS.find((option) => option.value === origin)?.label ?? origin;
}

function AuditSubject({
  subject,
  onFilterToEntity,
}: {
  subject: AuditEventSubject;
  onFilterToEntity: (subject: AuditEventSubject) => void;
}) {
  const base = ENTITY_ROUTE_BASE[subject.entityType];
  const label = `${subject.entityType} ${shortId(subject.entityId)}`;
  return (
    <div className="cell-truncate-action">
      <Tooltip content={subject.entityId}>
        {base ? (
          <Link to={`${base}/${subject.entityId}`} className="cell-truncate">
            {label}
          </Link>
        ) : (
          <span className="cell-truncate" tabIndex={0}>
            {label}
          </span>
        )}
      </Tooltip>
      <IconButton
        icon={<IconSearch size={14} />}
        aria-label={`Filter to ${label}`}
        variant="ghost"
        size="sm"
        onClick={() => onFilterToEntity(subject)}
      />
    </div>
  );
}

/** One applied filter, echoing what a filter control — or the row shortcut that fills
 * `entityType`/`entityId` directly — actually did. Its remove control is a real labelled button
 * rather than the chip itself being clickable, so the accessible name states which filter it
 * clears without relying on visual position. */
function FilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <li className="filter-chip">
      <span>
        {label}: {value}
      </span>
      <IconButton
        icon={<span aria-hidden="true">×</span>}
        aria-label={`Remove ${label} filter`}
        variant="ghost"
        size="sm"
        className="filter-chip-remove"
        onClick={onRemove}
      />
    </li>
  );
}

export default function AuditEventsPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedOrigin = urlState.origin as AuditEventOrigin | '';
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'createdAt');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'desc');
  const skip = clampSkip(urlState.skip);
  const pageSize = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, 25);
  const dateRange = readDateRange(urlState);
  const dateRangeActive = isDateRangeActive(dateRange);
  // `''` while the range filters nothing, so revealing an empty Custom range neither refetches nor
  // announces; the `DateRange` change handler below resets `skip` on the same key, so it stays put
  // too.
  const dateKey = dateRangeKey(dateRange);

  // Set only by the entity id's own apply, and cleared by every handler that rewrites `entityId`.
  const [entityIdError, setEntityIdError] = useState<string | undefined>(undefined);

  // The text filters apply 300 ms after typing stops, or at once on Enter. Each writes the URL
  // only when its value differs from it, so an unchanged value never resets paging.
  function applyAction(value: string) {
    if (value !== urlState.action) setUrlState({ action: value, skip: URL_DEFAULTS.skip });
  }

  // An invalid id never reaches the URL: it shows its error on the field and leaves focus where
  // it is, since nothing was submitted.
  function applyEntityId(value: string) {
    if (value !== '' && !ENTITY_ID_PATTERN.test(value)) {
      setEntityIdError(ENTITY_ID_ERROR);
      return;
    }
    setEntityIdError(undefined);
    if (value !== urlState.entityId) setUrlState({ entityId: value, skip: URL_DEFAULTS.skip });
  }

  const action = useDebouncedApply(urlState.action, applyAction);
  const entityId = useDebouncedApply(urlState.entityId, applyEntityId);

  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Best-effort id-to-email lookup for the Actor column, built once on mount. `listUsers` caps at
  // 100 and has no `ids` filter, so a tenant past its first page of members resolves only those —
  // the rest fall back to a short id. Fails OPEN: a rejected or partial lookup renders short ids
  // and never sets the page error.
  const [actorEmailById, setActorEmailById] = useState<Map<string, string>>(new Map());

  useAbortableEffect((isCurrent) => {
    return listUsers({ limit: 100 })
      .then(({ docs }) => {
        if (!isCurrent()) return;
        setActorEmailById(new Map(docs.map((user) => [user.id, user.email])));
      })
      .catch(() => {
        // Unresolved actors keep rendering their short id; the table stays usable either way.
      });
  }, []);

  // Identifies which applied filter values (excluding sort/skip) the rows currently on screen
  // belong to. A refresh that only re-sorts or re-pages the same filter keeps the old rows on a
  // failure; a refresh triggered by a changed filter blanks them instead, so a reader is never
  // shown one filter's rows under another filter's chips.
  const filterKey = JSON.stringify([
    urlState.action,
    urlState.entityType,
    urlState.entityId,
    appliedOrigin,
    urlState.refusalReason,
    dateKey,
  ]);
  const loadedFilterKeyRef = useRef<string | null>(null);
  const announceResult = useResultAnnouncer();

  useAbortableEffect(
    (isCurrent) => {
      // Resolved here, not during render: a `24h` range yields new instants on every call.
      const { from, to } = toDateRangeInstants(dateRange);
      return listAuditEvents({
        skip,
        limit: pageSize,
        action: urlState.action || undefined,
        entityType: urlState.entityType || undefined,
        entityId: urlState.entityId || undefined,
        origin: appliedOrigin === '' ? undefined : appliedOrigin,
        refusalReason: urlState.refusalReason || undefined,
        sort,
        sortDir,
        from,
        to,
      })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setEvents(docs);
          setCount(total);
          setError(null);
          loadedFilterKeyRef.current = filterKey;
          announceResult(filterKey, `${total} audit event${total === 1 ? '' : 's'}`);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setError(err instanceof Error ? err.message : 'Failed to load audit events');
          if (loadedFilterKeyRef.current !== filterKey) setEvents(null);
        });
    },
    [
      skip,
      pageSize,
      urlState.action,
      urlState.entityType,
      urlState.entityId,
      appliedOrigin,
      urlState.refusalReason,
      dateKey,
      sort,
      sortDir,
      filterKey,
      announceResult,
    ],
  );

  // Clear and the row shortcut reset the text drafts directly, because their target value can
  // already equal what's applied — an already-empty filter, or the same entity id a shortcut
  // re-selects — leaving no applied change for the drafts to re-sync from. Chip removal always
  // changes what's applied, so its drafts re-sync on their own. Each of the three also drops the
  // entity id error, which is page state that re-sync does not reach.
  function handleClear() {
    setEntityIdError(undefined);
    action.reset(URL_DEFAULTS.action);
    entityId.reset(URL_DEFAULTS.entityId);
    setUrlState({
      action: '',
      entityType: '',
      entityId: '',
      origin: '',
      refusalReason: '',
      range: '',
      from: '',
      to: '',
      skip: URL_DEFAULTS.skip,
    });
  }

  // The only no-paste route to a specific entity id: a reader has no ObjectId to hand, but every
  // subject already on screen has one.
  function handleFilterToEntity(subject: AuditEventSubject) {
    setEntityIdError(undefined);
    entityId.reset(subject.entityId);
    setUrlState({
      entityType: subject.entityType,
      entityId: subject.entityId,
      skip: URL_DEFAULTS.skip,
    });
  }

  function handleRemoveFilter(key: FilterKey) {
    if (key === 'entityId') setEntityIdError(undefined);
    const patch: Partial<typeof URL_DEFAULTS> = { skip: URL_DEFAULTS.skip };
    if (key === 'recorded') {
      patch.range = '';
      patch.from = '';
      patch.to = '';
    } else {
      patch[key] = '';
    }
    setUrlState(patch);
  }

  function handleSort(field: AuditEventSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction. A per-field default direction would make a URL written by one column
    // read back with the wrong direction once shared or reloaded, since `useUrlState` carries
    // exactly one default `sortDir` for every field.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  const chips: { key: FilterKey; label: string; value: string }[] = [
    urlState.action ? { key: 'action' as const, label: 'Action', value: urlState.action } : null,
    urlState.entityType
      ? { key: 'entityType' as const, label: 'Entity type', value: urlState.entityType }
      : null,
    urlState.entityId
      ? { key: 'entityId' as const, label: 'Entity id', value: shortId(urlState.entityId) }
      : null,
    appliedOrigin
      ? { key: 'origin' as const, label: 'Origin', value: originLabel(appliedOrigin) }
      : null,
    urlState.refusalReason
      ? { key: 'refusalReason' as const, label: 'Refusal reason', value: urlState.refusalReason }
      : null,
    dateRangeActive
      ? {
          key: 'recorded' as const,
          label: 'Recorded',
          value:
            dateRange.range === 'custom'
              ? `${dateRange.from || '…'} → ${dateRange.to || '…'}`
              : (DATE_RANGE_OPTIONS.find((option) => option.value === dateRange.range)?.label ??
                dateRange.range),
        }
      : null,
  ].filter((chip): chip is { key: FilterKey; label: string; value: string } => chip !== null);

  const hasFilter = chips.length > 0;

  let status: RecordListStatus;
  if (events === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading audit events…' };
  } else {
    // Zero rows still resolves to `ready` rather than RecordListPage's own `empty` kind — that
    // kind's EmptyState carries no `className`, and the unfiltered case needs `empty-state--zero`
    // to read as an earned-zero state rather than a filtered-empty one.
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Admin"
      title="Audit events"
      description="Every recorded action, filterable by action, entity type, id, origin, refusal reason or a recorded date range. Click the search icon beside a subject below to filter to it directly."
      skeletonVariant="table"
      filters={
        <div className="audit-filters">
          <FilterBar label="Audit filters" onClear={handleClear} hasFilter={hasFilter}>
            {/* `onSearch` also fires from the clear control right after `onChange('')`, in the
                same handler; `flush` reads the draft ref that `onChange` already synced, and
                records the send so its echo cannot clobber a keystroke typed while the URL write
                is still in flight. */}
            <SearchInput
              label="Action"
              width="grow"
              value={action.draft}
              onChange={action.setDraft}
              onSearch={action.flush}
              placeholder="document.deleted"
            />
            <Select
              label="Entity type"
              width="sm"
              options={ENTITY_TYPE_OPTIONS}
              value={urlState.entityType}
              onChange={(value) => setUrlState({ entityType: value, skip: URL_DEFAULTS.skip })}
            />
            <Input
              id={ENTITY_ID_FIELD_ID}
              label="Entity id"
              width="grow"
              value={entityId.draft}
              onChange={entityId.setDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') entityId.flush();
              }}
              placeholder="65f1c2e4a1b2c3d4e5f6a7b8"
              error={entityIdError}
            />
            <Select
              label="Origin"
              width="sm"
              options={ORIGIN_OPTIONS}
              value={appliedOrigin}
              onChange={(value) => setUrlState({ origin: value, skip: URL_DEFAULTS.skip })}
            />
            <Select
              label="Refusal reason"
              width="sm"
              options={REFUSAL_REASON_OPTIONS}
              value={urlState.refusalReason}
              onChange={(value) => setUrlState({ refusalReason: value, skip: URL_DEFAULTS.skip })}
            />
            <DateRange
              label="Recorded"
              value={dateRange}
              onChange={(value) =>
                setUrlState({
                  ...writeDateRange(value),
                  ...(dateRangeKey(value) !== dateKey ? { skip: URL_DEFAULTS.skip } : {}),
                })
              }
            />
          </FilterBar>
          {hasFilter && (
            <ul className="filter-chip-row" aria-label="Applied filters">
              {chips.map((chip) => (
                <FilterChip
                  key={chip.key}
                  label={chip.label}
                  value={chip.value}
                  onRemove={() => handleRemoveFilter(chip.key)}
                />
              ))}
            </ul>
          )}
        </div>
      }
      error={error ?? undefined}
      status={status}
      footer={
        events && (
          <Pager
            count={count}
            skip={skip}
            pageSize={pageSize}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
            onPageSizeChange={(next) =>
              setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })
            }
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        )
      }
    >
      {events && events.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconClipboard size={24} />}
          title="No matching audit events"
          description="Clear or adjust the filters above."
          // Not "Clear filters" — `FilterBar` already renders a button with that exact name
          // whenever `hasFilter` is true, and this empty state renders only in that same
          // condition, so identical wording would leave two controls with the same accessible
          // name on screen at once. `RunsPage`'s own filtered-empty action makes the same call
          // for the same reason.
          action={
            <Button variant="secondary" onClick={handleClear}>
              Show all events
            </Button>
          }
        />
      )}

      {events && events.length === 0 && !hasFilter && (
        <EmptyState
          className="empty-state--zero"
          icon={<IconClipboard size={24} />}
          title="No audit events yet"
          description="Actions recorded by the API and MCP surfaces appear here."
        />
      )}

      {events && events.length > 0 && (
        <Panel aria-label="Audit events matching the current filters">
          <Table caption="Audit events matching the current filters">
            <thead>
              <tr>
                <TableHeaderCell>Actor</TableHeaderCell>
                <SortableHeaderCell<AuditEventSortField>
                  field="action"
                  label="Action"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Subject</TableHeaderCell>
                <TableHeaderCell>Correlation</TableHeaderCell>
                <SortableHeaderCell<AuditEventSortField>
                  field="createdAt"
                  label="Recorded"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<AuditEventSortField>
                  field="origin"
                  label="Origin"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <TableCell label="Actor" className="cell-sub">
                    {actorEmailById.get(event.actor) ?? (
                      <>
                        {shortId(event.actor)}
                        <CopyButton text={event.actor} label="Copy actor id" iconOnly />
                      </>
                    )}
                  </TableCell>
                  <TableCell label="Action">
                    {event.action}
                    {event.modifiedCount !== undefined && (
                      <div className="cell-sub">{event.modifiedCount} documents modified</div>
                    )}
                  </TableCell>
                  <TableCell label="Subject" className="cell-sub">
                    <AuditSubject subject={event.subject} onFilterToEntity={handleFilterToEntity} />
                  </TableCell>
                  <TableCell label="Correlation" className="cell-sub mono">
                    <div className="cell-truncate-action">
                      <Tooltip content={event.correlationId}>
                        <span className="cell-truncate" tabIndex={0}>
                          {shortId(event.correlationId)}
                        </span>
                      </Tooltip>
                      <CopyButton text={event.correlationId} label="Copy correlation id" iconOnly />
                    </div>
                  </TableCell>
                  <TableCell label="Recorded" className="cell-sub">
                    <Timestamp value={event.createdAt} />
                    {event.timestamp !== event.createdAt && (
                      <div className="cell-sub">
                        Occurred <Timestamp value={event.timestamp} />
                      </div>
                    )}
                  </TableCell>
                  <TableCell label="Origin">
                    {event.origin === 'mcp' ? (
                      <>
                        <Badge tone="info">MCP</Badge>
                        {event.toolName && <div className="cell-sub mono">{event.toolName}</div>}
                        {event.refusalReason && (
                          <div className="cell-sub">
                            <Badge tone="caution">{event.refusalReason}</Badge>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="cell-sub">API</span>
                    )}
                  </TableCell>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </RecordListPage>
  );
}
