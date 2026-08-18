import { useEffect, useState, type FormEvent } from 'react';
import {
  answerEventsUrl,
  getAnswerById,
  listConflicts,
  startQuestion,
  type Answer,
} from '../api/client';
import AnswerView, { type ConflictChunkResolution } from '../components/AnswerView';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Field from '../components/ui/Field';
import { notify } from '../components/ui/toast';
import { buildDocumentVersionIndex, type ResolvedVersion } from '../lib/document-index';
import { useEventStream } from '../lib/use-event-stream';

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface AskPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
}

type BadgeTone = 'verified' | 'caution' | 'rejected' | 'info' | 'neutral';

// A run still in flight or failed shows its run status, never a premature outcome — matches
// AnswersPage's own tone assignment for the same three non-completed states.
const RUN_STATUS_TONE: Record<Exclude<Answer['runStatus'], 'completed'>, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  failed: 'rejected',
};

function outcomeBadge(answer: Answer): { tone: BadgeTone; label: string } {
  if (answer.runStatus !== 'completed') {
    return { tone: RUN_STATUS_TONE[answer.runStatus], label: answer.runStatus };
  }
  switch (answer.outcome?.kind) {
    case 'answered':
      return { tone: 'verified', label: 'answered' };
    case 'insufficient_evidence':
      return { tone: 'info', label: 'insufficient evidence' };
    case 'conflicting_evidence':
      return { tone: 'caution', label: 'conflicting evidence' };
    default:
      return { tone: 'neutral', label: answer.runStatus };
  }
}

// A run is terminal only on a named `answer` event carrying a finished runStatus — `heartbeat`
// never closes the stream, no matter what it carries.
function isTerminalAnswerEvent(eventName: string, data: Answer): boolean {
  return eventName === 'answer' && (data.runStatus === 'completed' || data.runStatus === 'failed');
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
      const message = err instanceof Error ? err.message : 'Failed to ask question';
      setError(message);
      notify('error', message);
    } finally {
      setSubmitting(false);
    }
  }

  const isTerminalRunStatus = answer?.runStatus === 'completed' || answer?.runStatus === 'failed';

  // SSE is the primary transport: a named `answer` event replaces the poll response, and a
  // terminal one closes the connection itself so a clean server-side finish is never mistaken for
  // a dropped connection and reopened (see use-event-stream.ts's own doc comment — a reopen would
  // re-trigger the server's qa.answer.viewed audit write). `heartbeat` only keeps the stream
  // 'live'; there is nothing in it this page renders.
  const streamState = useEventStream<Answer>({
    url: answerId ? answerEventsUrl(answerId) : null,
    events: ['answer', 'heartbeat'],
    onEvent: (eventName, data) => {
      if (eventName === 'answer') setAnswer(data);
    },
    onFallback: () => {},
    isTerminal: isTerminalAnswerEvent,
  });

  // Falls back to polling once the stream itself gives up — a server-authored error frame,
  // MAX_RECONNECT_ATTEMPTS transport failures, or no EventSource at all — gated on
  // `streamState === 'fallback'` rather than driving every answer unconditionally. Stops the
  // moment runStatus reaches a terminal value, same as the SSE path. `cancelled` drops a response
  // that lands after this effect is torn down instead of overwriting fresher state.
  useEffect(() => {
    if (!answerId) return;
    if (streamState !== 'fallback') return;
    if (isTerminalRunStatus) return;
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
  }, [answerId, streamState, isTerminalRunStatus, pollIntervalMs]);

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

  const isInFlight = answer?.runStatus === 'queued' || answer?.runStatus === 'running';

  return (
    <div className="view view--flow view--roomy">
      <div className="page-head">
        <div>
          <span className="eyebrow">Question & answer</span>
          <h1 className="page-title">Ask</h1>
          <p className="page-sub">Ask a question grounded in the uploaded evidence.</p>
        </div>
      </div>

      <section className="card">
        <form onSubmit={(e) => void handleSubmit(e)} className="form">
          <Field label="Question">
            {(inputProps) => (
              <input
                type="text"
                required
                value={questionText}
                onChange={(e) => setQuestionText(e.target.value)}
                placeholder="What is the cap rate for Northgate Business Park in Q1 2025?"
                {...inputProps}
              />
            )}
          </Field>
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Asking…' : 'Ask'}
            </Button>
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
              const badge = outcomeBadge(answer);
              return (
                <Badge tone={badge.tone}>
                  {isInFlight && <span className="badge-dot" />}
                  {badge.label}
                </Badge>
              );
            })()}
          </div>

          {isInFlight && (
            <p className="notice notice--info">
              <span className="live-dot" /> Answering…
            </p>
          )}

          {answer.runStatus === 'failed' && (
            <p className="error" role="alert">
              The question run failed.
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
