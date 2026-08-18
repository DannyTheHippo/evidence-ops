import { useEffect, useState, type FormEvent } from 'react';
import { listAuditEvents, type AuditEventView } from '../api/client';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';

const PAGE_SIZE = 25;

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

export default function AuditEventsPage() {
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  // Committed filter values — only these, not the input state, drive the fetch. Otherwise every
  // keystroke would refire the request instead of waiting for the filter form to be submitted.
  const [appliedFilters, setAppliedFilters] = useState({
    action: '',
    entityType: '',
    entityId: '',
  });

  useEffect(() => {
    listAuditEvents({
      skip,
      limit: PAGE_SIZE,
      action: appliedFilters.action || undefined,
      entityType: appliedFilters.entityType || undefined,
      entityId: appliedFilters.entityId || undefined,
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
    });
  }

  const hasPrev = skip > 0;
  const hasNext = skip + PAGE_SIZE < count;

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-sub">
            Every recorded action, filterable by action, entity type or id.
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
          description="Clear or adjust the action, entity type, and entity id filters above."
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
                <TableHeaderCell>Timestamp</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="cell-sub">{event.actor}</td>
                  <td>{event.action}</td>
                  <td className="cell-sub">
                    {event.subject.entityType} {event.subject.entityId}
                  </td>
                  <td className="cell-sub">{new Date(event.timestamp).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {events && (
        <div className="pager">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hasPrev}
            onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hasNext}
            onClick={() => setSkip((s) => s + PAGE_SIZE)}
          >
            Next
          </Button>
          <span className="cell-sub">{count} total</span>
        </div>
      )}
    </div>
  );
}
