import { useEffect, useState, type FormEvent } from 'react';
import {
  getAnswerById,
  listConflicts,
  startQuestion,
  type Answer,
  type Locator,
} from '../api/client';
import CitationPanel from '../components/CitationPanel';
import { buildDocumentVersionIndex, type ResolvedVersion } from '../lib/document-index';
import { formatLocator } from '../lib/locator';

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface ConflictChunkResolution {
  documentVersionId: string;
  locator: Locator;
}

interface AskPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

function statusBadge(answer: Answer): { className: string; label: string } {
  if (answer.runStatus !== 'completed') {
    if (answer.runStatus === 'failed') return { className: 'badge badge--failed', label: 'failed' };
    return { className: 'badge badge--neutral', label: answer.runStatus };
  }
  switch (answer.outcome?.kind) {
    case 'answered':
      return { className: 'badge badge--strong', label: 'answered' };
    case 'insufficient_evidence':
      return { className: 'badge badge--info', label: 'insufficient evidence' };
    case 'conflicting_evidence':
      return { className: 'badge badge--possible', label: 'conflicting evidence' };
    default:
      return { className: 'badge badge--neutral', label: answer.runStatus };
  }
}

export default function AskPage({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: AskPageProps) {
  const [questionText, setQuestionText] = useState('');
  const [answerId, setAnswerId] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [conflictChunkIndex, setConflictChunkIndex] = useState<
    Map<string, ConflictChunkResolution>
  >(new Map());

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setAnswer(null);
    setAnswerId(null);
    try {
      const result = await startQuestion(questionText);
      setAnswerId(result.id);
      setAnswer({
        id: result.id,
        questionText,
        runStatus: result.runStatus,
        citations: [],
        conflictIds: [],
        createdAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to ask question');
    } finally {
      setSubmitting(false);
    }
  }

  // Polls while the run is in flight; stops the moment runStatus leaves queued/running, matching
  // the API's separate runStatus/outcome axes (outcome is only meaningful once completed).
  // Depends on the status value, not the `answer` object, so one interval spans every tick that
  // reports the same status and the poll cadence stays fixed rather than drifting by the response
  // latency of each tick. `cancelled` drops a response that lands after this effect is torn down —
  // after unmount, or after a newer tick moved the answer on — instead of overwriting fresher state.
  useEffect(() => {
    if (!answerId) return;
    if (answer?.runStatus === 'completed' || answer?.runStatus === 'failed') return;
    let cancelled = false;

    const timer = setInterval(() => {
      getAnswerById(answerId)
        .then((next) => {
          if (!cancelled) setAnswer(next);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Failed to poll answer');
        });
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [answerId, answer?.runStatus, pollIntervalMs]);

  // Resolves citation/conflict-value document titles once there is something to resolve — a
  // conflicting_evidence outcome carries no citations, so that outcome alone must still trigger
  // this. Failure here must not affect answer rendering — see document-index.ts.
  useEffect(() => {
    if (answer?.runStatus !== 'completed') return;
    const hasCitations = answer.citations.length > 0;
    const hasConflict = answer.outcome?.kind === 'conflicting_evidence';
    if (!hasCitations && !hasConflict) return;
    let cancelled = false;

    buildDocumentVersionIndex()
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [answer?.runStatus, answer?.citations, answer?.outcome]);

  // Resolves conflicting_evidence source chunks to a document title + locator. Narrowed to this
  // answer's conflictIds; listConflicts({ limit: 100 }) is the API's max page size, so a chunk
  // belonging to a conflict past the first 100 falls back to its raw sourceChunkId below —
  // acceptable at demo scale, upgradeable to server-side enrichment without changing this contract.
  useEffect(() => {
    if (answer?.runStatus !== 'completed' || answer.outcome?.kind !== 'conflicting_evidence')
      return;
    if (answer.conflictIds.length === 0) return;
    let cancelled = false;

    listConflicts({ limit: 100 })
      .then(({ docs }) => {
        if (cancelled) return;
        const index = new Map<string, ConflictChunkResolution>();
        for (const conflict of docs) {
          if (!answer.conflictIds.includes(conflict.id)) continue;
          for (const value of conflict.values) {
            index.set(value.sourceChunkId, {
              documentVersionId: value.documentVersionId,
              locator: value.locator,
            });
          }
        }
        setConflictChunkIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [answer?.runStatus, answer?.outcome, answer?.conflictIds]);

  const isPolling = answer?.runStatus === 'queued' || answer?.runStatus === 'running';

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Question & answer</span>
          <h1 className="page-title">Ask</h1>
          <p className="page-sub">Ask a question grounded in the uploaded evidence.</p>
        </div>
      </div>

      <section className="card">
        <form onSubmit={(e) => void handleSubmit(e)} className="form">
          <label>
            Question
            <input
              type="text"
              required
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder="What is the cap rate for Northgate Business Park in Q1 2025?"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {answer && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{answer.questionText}</h2>
            {(() => {
              const badge = statusBadge(answer);
              return (
                <span className={badge.className}>
                  {isPolling && <span className="badge-dot" />}
                  {badge.label}
                </span>
              );
            })()}
          </div>

          {isPolling && (
            <p className="notice notice--info">
              <span className="live-dot" /> Answering…
            </p>
          )}

          {answer.runStatus === 'failed' && (
            <p className="error" role="alert">
              The question run failed.
            </p>
          )}

          {answer.runStatus === 'completed' && answer.outcome && (
            <div className="answer-outcome">
              {typeof answer.claimCoverage === 'number' && (
                <p className="card-meta">
                  Claim coverage: {Math.round(answer.claimCoverage * 100)}%
                </p>
              )}

              {answer.outcome.kind === 'answered' && (
                <ul className="claims">
                  {answer.outcome.claims.map((claim, claimIndex) => (
                    <li key={claimIndex} className="claim">
                      <p className="claim-statement">{claim.statement}</p>
                      <ul className="citations">
                        {claim.citations.map((citation, citationIndex) => (
                          <CitationPanel
                            key={citationIndex}
                            citation={citation}
                            resolved={documentIndex.get(citation.docVersionId)}
                          />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}

              {answer.outcome.kind === 'insufficient_evidence' && (
                <p className="notice notice--info">{answer.outcome.reason}</p>
              )}

              {answer.outcome.kind === 'conflicting_evidence' && (
                <div className="conflict-block">
                  <p className="card-meta">
                    {answer.outcome.factKey.entity} — {answer.outcome.factKey.metric} (
                    {answer.outcome.factKey.period})
                  </p>
                  <ul className="value-compare">
                    {answer.outcome.values.map((value, valueIndex) => {
                      const chunkResolution = conflictChunkIndex.get(value.sourceChunkId);
                      const resolvedVersion =
                        chunkResolution && documentIndex.get(chunkResolution.documentVersionId);
                      const sourceLabel = resolvedVersion
                        ? `${resolvedVersion.documentTitle} — ${formatLocator(chunkResolution.locator)}`
                        : value.sourceChunkId;
                      return (
                        <li key={valueIndex} className="value-compare-item">
                          <span className="mono">
                            {value.value} {value.unit}
                          </span>
                          <span className="cell-sub">{sourceLabel}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
