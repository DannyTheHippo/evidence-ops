import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  listAuditEvents,
  type AuditEventOrigin,
  type AuditEventSubject,
  type AuditEventView,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import { shortId } from '../lib/identifiers';

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

function AuditSubject({ subject }: { subject: AuditEventSubject }) {
  const base = ENTITY_ROUTE_BASE[subject.entityType];
  const label = `${subject.entityType} ${shortId(subject.entityId)}`;
  return base ? (
    <Link to={`${base}/${subject.entityId}`} title={subject.entityId}>
      {label}
    </Link>
  ) : (
    <span title={subject.entityId}>{label}</span>
  );
}

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

export default function AuditEventsPage() {
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [origin, setOrigin] = useState<AuditEventOrigin | ''>('');
  const [refusalReason, setRefusalReason] = useState('');
  // Committed filter values — only these, not the input state, drive the fetch. Otherwise every
  // keystroke would refire the request instead of waiting for the filter form to be submitted.
  const [appliedFilters, setAppliedFilters] = useState<{
    action: string;
    entityType: string;
    entityId: string;
    origin: AuditEventOrigin | '';
    refusalReason: string;
  }>({
    action: '',
    entityType: '',
    entityId: '',
    origin: '',
    refusalReason: '',
  });

  useEffect(() => {
    listAuditEvents({
      skip,
      limit: PAGE_SIZE,
      action: appliedFilters.action || undefined,
      entityType: appliedFilters.entityType || undefined,
      entityId: appliedFilters.entityId || undefined,
      origin: appliedFilters.origin === '' ? undefined : appliedFilters.origin,
      refusalReason: appliedFilters.refusalReason || undefined,
    })
      .then(({ docs, count: total }) => {
        setEvents(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load audit events');
      });
  }, [skip, appliedFilters]);

  function handleFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSkip(0);
    setAppliedFilters({
      action: action.trim(),
      entityType: entityType.trim(),
      entityId: entityId.trim(),
      origin,
      refusalReason,
    });
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-sub">
            Every recorded action, filterable by action, entity type, id, origin or refusal reason.
          </p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Filters</h2>
        </div>
        <form onSubmit={handleFilter} className="form">
          <Field label="Action">
            {(inputProps) => (
              <input
                type="text"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="document.deleted"
                {...inputProps}
              />
            )}
          </Field>
          <Select
            label="Entity type"
            options={ENTITY_TYPE_OPTIONS}
            value={entityType}
            onChange={setEntityType}
          />
          <Field label="Entity id">
            {(inputProps) => (
              <input
                type="text"
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
                placeholder="65f1c2e4a1b2c3d4e5f6a7b8"
                {...inputProps}
              />
            )}
          </Field>
          <Select
            label="Origin"
            options={ORIGIN_OPTIONS}
            value={origin}
            onChange={(value) => setOrigin(value as AuditEventOrigin | '')}
          />
          <Select
            label="Refusal reason"
            options={REFUSAL_REASON_OPTIONS}
            value={refusalReason}
            onChange={setRefusalReason}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary">
              Apply filters
            </Button>
          </div>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!events && !error && <Skeleton label="Loading…" />}

      {events && events.length === 0 && (
        <EmptyState
          title="No audit events match these filters."
          description="Clear or adjust the filters above."
        />
      )}

      {events && events.length > 0 && (
        <section className="panel">
          <Table caption="Audit events matching the current filters">
            <thead>
              <tr>
                <TableHeaderCell>Actor</TableHeaderCell>
                <TableHeaderCell>Action</TableHeaderCell>
                <TableHeaderCell>Subject</TableHeaderCell>
                <TableHeaderCell>Correlation</TableHeaderCell>
                <TableHeaderCell>Timestamp</TableHeaderCell>
                <TableHeaderCell>Origin</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="cell-sub">{event.actor}</td>
                  <td>
                    {event.action}
                    {event.refusalReason && (
                      <div>
                        <span className="cell-truncate" title={event.refusalReason}>
                          {event.refusalReason}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="cell-sub">
                    <AuditSubject subject={event.subject} />
                  </td>
                  <td className="cell-sub mono" title={event.correlationId}>
                    {shortId(event.correlationId)}
                  </td>
                  <td className="cell-sub">{new Date(event.timestamp).toLocaleString()}</td>
                  <td>
                    {event.origin === 'mcp' ? (
                      <>
                        <Badge tone="info">MCP</Badge>
                        {event.toolName && <div className="cell-sub">{event.toolName}</div>}
                      </>
                    ) : (
                      <span className="cell-sub">api</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {events && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}
    </div>
  );
}
