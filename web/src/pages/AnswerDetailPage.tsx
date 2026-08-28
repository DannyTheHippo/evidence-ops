import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getAnswerById, type Answer } from '../api/client';
import AnswerView from '../components/AnswerView';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { RUN_STATUS_TONE } from '../lib/answer-status';
import { useAnswerEnrichment } from '../lib/use-answer-enrichment';

export default function AnswerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `cancelled` (matching ConflictsPage.tsx's own document-index effect) stops a response for a
  // stale `id` from landing after navigation moves to a different answer — without it, `/answers/A`
  // → `/answers/B` can render A's claims under B's url if A's fetch resolves after B's.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    getAnswerById(id)
      .then((result) => {
        if (cancelled) return;
        setAnswer(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load answer');
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  const { documentIndex, conflictChunkIndex } = useAnswerEnrichment(answer);

  return (
    <div className="view view--roomy">
      <div className="page-head">
        <div>
          <span className="eyebrow">Ask</span>
          <h1 className="page-title">{answer ? answer.questionText : 'Answer'}</h1>
          <p className="page-sub">A previously asked question and its grounding.</p>
        </div>
        <Link to="/answers" className="btn btn--secondary btn--sm">
          Back to answers
        </Link>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!id && (
        <p className="error error--page" role="alert">
          No answer id provided.
        </p>
      )}

      {notFound && <p className="notice notice--info">Answer not found.</p>}

      {!answer && !error && !notFound && id && <Skeleton label="Loading answer…" />}

      {answer && (
        <section className="card">
          {answer.runStatus !== 'completed' && (
            <div className="card-head">
              <Badge tone={RUN_STATUS_TONE[answer.runStatus]}>{answer.runStatus}</Badge>
            </div>
          )}

          {answer.runStatus === 'failed' && (
            <p className="error" role="alert">
              The question run failed.
            </p>
          )}

          {(answer.runStatus === 'queued' || answer.runStatus === 'running') && (
            <p className="notice notice--info">
              <span className="live-dot" /> Still answering — check back once this run completes.
            </p>
          )}

          <AnswerView
            answer={answer}
            documentIndex={documentIndex}
            conflictChunkIndex={conflictChunkIndex}
          />
        </section>
      )}
    </div>
  );
}
