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

  function handleSort(field: AuditEventSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction. A per-field default direction would make a URL written by one column
    // read back with the wrong direction once shared or reloaded, since `useUrlState` carries
    // exactly one default `sortDir` for every field.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  const hasFilter =
    urlState.action !== '' ||
    urlState.entityType !== '' ||
    urlState.entityId !== '' ||
    appliedOrigin !== '' ||
    urlState.refusalReason !== '';

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
    };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Admin"
      title="Audit Log"
      description="Every recorded action, filterable by action, entity type, id, origin or refusal reason."
      filters={
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
                    {event.refusalReason && (
                      <div>
                        <span className="cell-truncate" title={event.refusalReason}>
                          {event.refusalReason}
                        </span>
                      </div>
                    )}
                    {event.modifiedCount !== undefined && (
                      <div className="cell-sub">{event.modifiedCount} documents modified</div>
                    )}
                  </TableCell>
                  <TableCell label="Subject" className="cell-sub">
                    <AuditSubject subject={event.subject} onFilterToEntity={handleFilterToEntity} />
                  </TableCell>
                  <TableCell
                    label="Correlation"
                    className="cell-sub mono"
                    title={event.correlationId}
                  >
                    {shortId(event.correlationId)}
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
                        {event.toolName && <div className="cell-sub">{event.toolName}</div>}
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
