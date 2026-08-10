import { useEffect, useState } from 'react';
import { listConflicts, type Conflict } from '../api/client';

function statusBadgeClass(status: Conflict['status']): string {
  if (status === 'open') return 'badge badge--possible';
  if (status === 'resolved') return 'badge badge--strong';
  return 'badge badge--neutral';
}

export default function ConflictsPage() {
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listConflicts()
      .then(({ docs }) => setConflicts(docs))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load conflicts');
      });
  }, []);

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">Conflicts</h1>
          <p className="page-sub">Facts extracted from the evidence corpus that disagree.</p>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="panel">
        <table className="grid">
          <thead>
            <tr>
              <th>Entity</th>
              <th>Metric</th>
              <th>Period</th>
              <th>Magnitude</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {conflicts && conflicts.length === 0 && (
              <tr>
                <td className="grid-empty" colSpan={5}>
                  No conflicts detected.
                </td>
              </tr>
            )}
            {conflicts?.map((conflict) => (
              <tr key={conflict.id}>
                <td>{conflict.factKey.entity}</td>
                <td className="cell-sub">{conflict.factKey.metric}</td>
                <td className="cell-sub">{conflict.factKey.period}</td>
                <td className="num">{conflict.magnitude}</td>
                <td>
                  <span className={statusBadgeClass(conflict.status)}>{conflict.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
