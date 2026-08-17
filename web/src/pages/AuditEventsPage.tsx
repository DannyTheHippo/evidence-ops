import { useEffect, useState, type FormEvent } from 'react';
import { listAuditEvents, type AuditEventView } from '../api/client';

const PAGE_SIZE = 25;

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
          <label>
            Action
            <input
              type="text"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="document.deleted"
            />
          </label>
          <label>
            Entity type
            <input
              type="text"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              placeholder="Document"
            />
          </label>
          <label>
            Entity id
            <input
              type="text"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              placeholder="65f1c2e4a1b2c3d4e5f6a7b8"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary">
              Apply filters
            </button>
          </div>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!events && !error && <p>Loading…</p>}

      {events && events.length === 0 && (
        <p className="notice notice--info">No audit events match these filters.</p>
      )}

      {events && events.length > 0 && (
        <section className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Actor</th>
                <th>Action</th>
                <th>Subject</th>
                <th>Timestamp</th>
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
          </table>
        </section>
      )}

      {events && (
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={!hasPrev}
            onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={!hasNext}
            onClick={() => setSkip((s) => s + PAGE_SIZE)}
          >
            Next
          </button>
          <span className="cell-sub">{count} total</span>
        </div>
      )}
    </div>
  );
}
