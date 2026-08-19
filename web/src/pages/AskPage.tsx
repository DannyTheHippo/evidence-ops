import { useEffect, useRef, useState, type FormEvent } from 'react';
import { answerEventsUrl, getAnswerById, startQuestion, type Answer } from '../api/client';
import AnswerView from '../components/AnswerView';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Field from '../components/ui/Field';
import Skeleton from '../components/ui/Skeleton';
import { notify } from '../components/ui/toast';
import { answerBadge } from '../lib/answer-status';
import { useAnswerEnrichment } from '../lib/use-answer-enrichment';
import { useEventStream } from '../lib/use-event-stream';

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface AskPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
  pollIntervalMs?: number;
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
  // Blocks a double submit between the click and the re-render that disables the submit button —
  // `disabled={submitting}` alone only takes effect once React has committed it.
  const submitInFlightRef = useRef(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
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
      submitInFlightRef.current = false;
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

  const { documentIndex, conflictChunkIndex } = useAnswerEnrichment(answer);

  const isInFlight = answer?.runStatus === 'queued' || answer?.runStatus === 'running';

  return (
    <div className="view view--roomy">
      <div className="page-head">
        <div>
          <span className="eyebrow">Ask</span>
          <h1 className="page-title">Ask</h1>
          <p className="page-sub">Ask a question grounded in the uploaded evidence.</p>
        </div>
      </div>

      {/* Untitled, unlike a filter card — the question field is the page's purpose, not a
          refinement of something below it, and a "Ask" heading under a page title that already
          reads Ask would repeat itself. */}
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
              const badge = answerBadge(answer);
              return (
                <Badge tone={badge.tone}>
                  {isInFlight && <span className="live-dot" />}
                  {badge.label}
                </Badge>
              );
            })()}
          </div>

          {isInFlight && (
            <>
              <p className="notice notice--info">
                <span className="live-dot" /> Answering…
              </p>
              {/* The outcome arrives as one atomic snapshot, never incrementally, so this stands
                  in for the ledger and apparatus rows rather than filling progressively. */}
              <Skeleton label="Answering…" lines={6} />
            </>
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
