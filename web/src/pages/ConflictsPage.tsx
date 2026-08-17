import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listConflicts, requestConflictResolution, type Conflict } from '../api/client';
import { buildDocumentVersionIndex, type ResolvedVersion } from '../lib/document-index';
import { formatLocator } from '../lib/locator';

function statusBadgeClass(status: Conflict['status']): string {
  if (status === 'open') return 'badge badge--possible';
  if (status === 'resolved') return 'badge badge--strong';
  return 'badge badge--neutral';
}

export default function ConflictsPage() {
  const navigate = useNavigate();
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [resolvingFactId, setResolvingFactId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    listConflicts()
      .then(({ docs }) => setConflicts(docs))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load conflicts');
      });
  }, []);

  // Resolves value document titles once there is something to resolve. Failure here must not
  // affect conflict rendering — see document-index.ts.
  useEffect(() => {
    if (!conflicts || conflicts.length === 0) return;
    let cancelled = false;

    buildDocumentVersionIndex()
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [conflicts]);

  async function handleResolve(conflictId: string, factId: string) {
    setResolvingFactId(factId);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[factId];
      return next;
    });
    try {
      const run = await requestConflictResolution(conflictId, factId);
      await navigate(`/workflow-runs/${run.id}`);
    } catch (err: unknown) {
      setRowErrors((current) => ({
        ...current,
        [factId]: err instanceof Error ? err.message : 'Failed to request resolution',
      }));
    } finally {
      setResolvingFactId(null);
    }
  }

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

      {!conflicts && !error && <p>Loading…</p>}

      <section className="panel">
        <table className="grid">
          <thead>
            <tr>
              <th>Entity</th>
              <th>Metric</th>
              <th>Period</th>
              <th>Magnitude</th>
              <th>Status</th>
              <th>Values</th>
            </tr>
          </thead>
          <tbody>
            {conflicts && conflicts.length === 0 && (
              <tr>
                <td className="grid-empty" colSpan={6}>
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
                <td>
                  {conflict.ruleFired === 'none' && (
                    <p className="cell-sub">
                      Policy has no recommendation for this conflict — {conflict.explanation}
                    </p>
                  )}
                  <ul className="value-compare">
                    {conflict.values.map((value) => {
                      const resolved = documentIndex.get(value.documentVersionId);
                      const title = resolved?.documentTitle ?? 'Unknown document';
                      const isRecommended = value.factId === conflict.proposedWinnerFactId;
                      return (
                        <li
                          key={value.factId}
                          className={
                            isRecommended
                              ? 'value-compare-item value-compare-item--recommended'
                              : 'value-compare-item'
                          }
                        >
                          <span className="mono">
                            {value.value} {value.unit}
                          </span>
                          <span className="cell-sub">
                            {title} — {formatLocator(value.locator)}
                          </span>
                          {isRecommended && (
                            <>
                              <span className="badge badge--info">
                                <span className="badge-dot" />
                                Recommended · {conflict.ruleFired}
                              </span>
                              <p className="cell-sub">{conflict.explanation}</p>
                            </>
                          )}
                          {conflict.status === 'open' && (
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              disabled={resolvingFactId === value.factId}
                              onClick={() => void handleResolve(conflict.id, value.factId)}
                            >
                              {resolvingFactId === value.factId
                                ? 'Requesting…'
                                : 'Request resolution'}
                            </button>
                          )}
                          {rowErrors[value.factId] && (
                            <p className="error" role="alert">
                              {rowErrors[value.factId]}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
