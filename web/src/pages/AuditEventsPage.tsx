import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listAuditEvents,
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
import FilterBar from '../components/ui/FilterBar';
import IconButton from '../components/ui/IconButton';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { shortId } from '../lib/identifiers';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 25;

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
  { value: 'api', label: 'api' },
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
  'action' | 'entityType' | 'entityId' | 'origin' | 'refusalReason' | 'sort' | 'sortDir' | 'skip',
  string
> = {
  action: '',
  entityType: '',
  entityId: '',
  origin: '',
  refusalReason: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

// The keys a chip can remove — every filter URL_DEFAULTS carries except sort/sortDir/skip, which
// no chip ever touches.
type FilterKey = 'action' | 'entityType' | 'entityId' | 'origin' | 'refusalReason';

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
    <>
      {base ? (
        <Link to={`${base}/${subject.entityId}`} className="cell-truncate" title={subject.entityId}>
          {label}
        </Link>
      ) : (
        <span className="cell-truncate" title={subject.entityId}>
          {label}
        </span>
      )}
      <IconButton
        icon={<IconSearch size={14} />}
        aria-label={`Filter to ${label}`}
        variant="ghost"
        size="sm"
        onClick={() => onFilterToEntity(subject)}
      />
    </>
  );
}

/** One applied filter, echoing what a submitted `FilterBar` — or the row shortcut that fills
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
  const sort = urlState.sort as AuditEventSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  // Only these, not the controls' own values, drive the fetch — filters apply on submit, not on
  // every keystroke or selection change.
  const [draftAction, setDraftAction] = useState(urlState.action);
  const [draftEntityType, setDraftEntityType] = useState(urlState.entityType);
  const [draftEntityId, setDraftEntityId] = useState(urlState.entityId);
  const [draftOrigin, setDraftOrigin] = useState(appliedOrigin);
  const [draftRefusalReason, setDraftRefusalReason] = useState(urlState.refusalReason);

  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAuditEvents({
      skip,
      limit: PAGE_SIZE,
      action: urlState.action || undefined,
      entityType: urlState.entityType || undefined,
      entityId: urlState.entityId || undefined,
      origin: appliedOrigin === '' ? undefined : appliedOrigin,
      refusalReason: urlState.refusalReason || undefined,
      sort,
      sortDir,
    })
      .then(({ docs, count: total }) => {
        setEvents(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load audit events');
      });
  }, [
    skip,
    urlState.action,
    urlState.entityType,
    urlState.entityId,
    appliedOrigin,
    urlState.refusalReason,
    sort,
    sortDir,
  ]);

  function handleApply() {
    setUrlState({
      action: draftAction,
      entityType: draftEntityType,
      entityId: draftEntityId,
      origin: draftOrigin,
      refusalReason: draftRefusalReason,
      skip: URL_DEFAULTS.skip,
    });
  }

  function handleClear() {
    setDraftAction('');
    setDraftEntityType('');
    setDraftEntityId('');
    setDraftOrigin('');
    setDraftRefusalReason('');
    setUrlState({
      action: '',
      entityType: '',
      entityId: '',
      origin: '',
      refusalReason: '',
      skip: URL_DEFAULTS.skip,
    });
  }

  // The only no-paste route to a specific entity id: a reader has no ObjectId to hand, but every
  // subject already on screen has one. Updates the drafts too, so the filter form reflects what
  // just got applied rather than reading stale.
  function handleFilterToEntity(subject: AuditEventSubject) {
    setDraftEntityType(subject.entityType);
    setDraftEntityId(subject.entityId);
    setUrlState({
      entityType: subject.entityType,
      entityId: subject.entityId,
      skip: URL_DEFAULTS.skip,
    });
  }

  // A chip clears one applied filter — both the URL (what the fetch reads) and the matching draft
  // (what the form shows), so a later "Apply filters" cannot silently resurrect the value the
  // chip just removed.
  function handleRemoveFilter(key: FilterKey) {
    if (key === 'action') setDraftAction('');
    else if (key === 'entityType') setDraftEntityType('');
    else if (key === 'entityId') setDraftEntityId('');
    else if (key === 'origin') setDraftOrigin('');
    else setDraftRefusalReason('');
    const patch: Partial<typeof URL_DEFAULTS> = { skip: URL_DEFAULTS.skip };
    patch[key] = '';
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
  ].filter((chip): chip is { key: FilterKey; label: string; value: string } => chip !== null);

  const hasFilter = chips.length > 0;

  let status: RecordListStatus;
  if (events === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading audit events…' };
  } else if (events.length === 0) {
    status = {
      kind: 'empty',
      icon: <IconClipboard size={24} />,
      title: 'No matching audit events',
      description: hasFilter
        ? 'Clear or adjust the filters above.'
        : 'Actions recorded by the API and MCP surfaces appear here.',
      // Not "Clear filters" — `FilterBar` already renders a button with that exact name
      // whenever `hasFilter` is true, and this empty state renders only in that same condition,
      // so identical wording would leave two controls with the same accessible name on screen at
      // once. `RunsPage`'s own filtered-empty action makes the same call for the same reason.
      action: hasFilter ? (
        <Button variant="secondary" onClick={handleClear}>
          Show all events
        </Button>
      ) : undefined,
    };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Organisation"
      title="Audit Log"
      description="Every recorded action, filterable by action, entity type, id, origin or refusal reason."
      filters={
        <div className="audit-filters">
          <FilterBar onApply={handleApply} onClear={handleClear} hasFilter={hasFilter}>
            <Input
              label="Action"
              value={draftAction}
              onChange={setDraftAction}
              placeholder="document.deleted"
            />
            <Select
              label="Entity type"
              options={ENTITY_TYPE_OPTIONS}
              value={draftEntityType}
              onChange={setDraftEntityType}
            />
            <Input
              label="Entity id"
              value={draftEntityId}
              onChange={setDraftEntityId}
              placeholder="65f1c2e4a1b2c3d4e5f6a7b8"
              hint="Or click the search icon beside a subject below to filter to it directly."
            />
            <Select
              label="Origin"
              options={ORIGIN_OPTIONS}
              value={draftOrigin}
              onChange={(value) => setDraftOrigin(value as AuditEventOrigin | '')}
            />
            <Select
              label="Refusal reason"
              options={REFUSAL_REASON_OPTIONS}
              value={draftRefusalReason}
              onChange={setDraftRefusalReason}
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
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {events && events.length > 0 && (
        <section
          className="panel"
          tabIndex={0}
          role="region"
          aria-label="Audit events matching the current filters"
        >
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
                    {event.actor}
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
                    <span title={event.correlationId}>{shortId(event.correlationId)}</span>
                    <CopyButton text={event.correlationId} label="Copy correlation id" iconOnly />
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
                      <span className="cell-sub">api</span>
                    )}
                  </TableCell>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </RecordListPage>
  );
}
