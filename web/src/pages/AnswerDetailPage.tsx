import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getAnswerById, listConflicts, type Answer } from '../api/client';
import AnswerView, { type ConflictChunkResolution } from '../components/AnswerView';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { buildDocumentVersionIndex, type ResolvedVersion } from '../lib/document-index';

// A run still in flight or failed shows its run status as a badge — matches AnswersPage's own
// tone assignment for the same three non-completed states.
const RUN_STATUS_TONE: Record<
  Exclude<Answer['runStatus'], 'completed'>,
  'neutral' | 'info' | 'rejected'
> = {
  queued: 'neutral',
  running: 'info',
  failed: 'rejected',
};

export default function AnswerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [conflictChunkIndex, setConflictChunkIndex] = useState<
    Map<string, ConflictChunkResolution>
  >(new Map());

  useEffect(() => {
    if (!id) return;
    getAnswerById(id)
      .then((result) => {
        setAnswer(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load answer');
      });
  }, [id]);

  // Resolves citation/conflict-value document titles for a completed answer — mirrors AskPage's
  // own effect. Failure here must not affect answer rendering — see document-index.ts.
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

  // Resolves conflicting_evidence source chunks to a document title + locator — mirrors AskPage's
  // own effect. Narrowed to this answer's conflictIds; listConflicts({ limit: 100 }) is the API's
  // max page size, so a chunk belonging to a conflict past the first 100 falls back to its raw
  // sourceChunkId in AnswerView.
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

  return (
    <div className="view view--flow view--roomy">
      <div className="page-head">
        <div>
          <span className="eyebrow">Question & answer</span>
          <h1 className="page-title">{answer ? answer.questionText : 'Answer'}</h1>
          <p className="page-sub">A previously asked question and its grounding.</p>
        </div>
        <Link to="/answers" className="btn btn--secondary btn--sm">
          Back to answers
        </Link>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!id && (
        <p className="error" role="alert">
          No answer id provided.
        </p>
      )}

      {notFound && <p className="notice notice--info">Answer not found.</p>}

      {!answer && !error && !notFound && id && <Skeleton label="Loading…" />}

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
