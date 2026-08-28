import { useEffect, useState } from 'react';
import { ApiError, answerEventsUrl, getAnswerById, type Answer } from '../api/client';
import { useEventStream } from './use-event-stream';

const DEFAULT_POLL_INTERVAL_MS = 1500;

// Distinct from every real `answerId` (including `null`), so the render-time reset below always
// fires once on mount — even when a caller mounts directly with a non-null `answerId` and a
// matching `initialAnswer`, which a plain `useState(answerId)` initializer would treat as already
// reset for, silently dropping the seed.
const UNSET = Symbol('answer-run-unset');

export interface UseAnswerRunOptions {
  answerId: string | null;
  pollIntervalMs?: number;
  /**
   * Seeds state for `answerId` without the hook's own fetch — AskPage passes the optimistic
   * snapshot it already built from `startQuestion()`'s response, so the hook's own GET on that
   * same id would only replay the 'queued' state the caller already has. Only consulted while
   * `answerId` is transitioning to this value: a caller that later replaces the object (or the
   * id moves on) never re-triggers the fetch this option exists to skip.
   */
  initialAnswer?: Answer | null;
}

export interface UseAnswerRunResult {
  answer: Answer | null;
  error: string | null;
  notFound: boolean;
}

/**
 * Owns an answer's lifecycle from `answerId` alone: the initial GET (skipped when `initialAnswer`
 * already carries it), the SSE subscription for live updates, and — once `useEventStream` reports
 * `'fallback'` — polling the same `getAnswerById` call until the run reaches a terminal
 * `runStatus`. `'fallback'` covers a server-authored error frame, exhausted transport retries, an
 * environment with no `EventSource` at all, and the API's own 30-minute stream ceiling
 * (`qa.service.ts`'s `takeUntil`) ending the connection out from under a browser that would
 * otherwise keep retrying it — in every case the run still reaches its terminal state on screen,
 * carried by the poll instead of the stream. Shared by AskPage, which seeds `initialAnswer` from
 * its own optimistic snapshot, and AnswerDetailPage, which has nothing to seed and always fetches.
 */
export function useAnswerRun({
  answerId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  initialAnswer = null,
}: UseAnswerRunOptions): UseAnswerRunResult {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Resets answer/error/notFound for a new `answerId` during render rather than in an effect —
  // the sanctioned pattern for adjusting state when a prop changes
  // (react.dev/learn/you-might-not-need-an-effect; WorkflowRunPage.tsx's own `everPaused` flag
  // uses the same escape hatch, tracked in state rather than a ref, since a ref mutated during
  // render is not safe under React's own rules). Reading `initialAnswer` here, synchronously, is
  // what lets a seed matching this render's `answerId` land before the first paint instead of one
  // commit later.
  const [resetForId, setResetForId] = useState<string | null | typeof UNSET>(UNSET);
  if (answerId !== resetForId) {
    setResetForId(answerId);
    setAnswer(answerId && initialAnswer?.id === answerId ? initialAnswer : null);
    setError(null);
    setNotFound(false);
  }

  // `cancelled` (matching AnswerDetailPage's own pre-existing pattern) stops a response for a
  // stale `answerId` from landing after a newer one has already taken over.
  useEffect(() => {
    if (!answerId) return;
    if (initialAnswer && initialAnswer.id === answerId) return;
    let cancelled = false;

    getAnswerById(answerId)
      .then((result) => {
        if (!cancelled) setAnswer(result);
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
  }, [answerId, initialAnswer]);

  const isTerminalRunStatus = answer?.runStatus === 'completed' || answer?.runStatus === 'failed';

  // SSE is the primary transport: a named `answer` event replaces the poll response, and a
  // terminal one closes the connection itself so a clean server-side finish is never mistaken for
  // a dropped connection and reopened (see use-event-stream.ts's own doc comment — a reopen would
  // re-trigger the server's qa.answer.viewed audit write). `heartbeat` only keeps the stream
  // 'live'; neither page renders anything from it.
  const streamState = useEventStream<Answer>({
    url: answerId ? answerEventsUrl(answerId) : null,
    events: ['answer', 'heartbeat'],
    onEvent: (eventName, data) => {
      if (eventName === 'answer') setAnswer(data);
    },
    onFallback: () => {},
    isTerminal: (eventName, data) =>
      eventName === 'answer' && (data.runStatus === 'completed' || data.runStatus === 'failed'),
  });

  // Falls back to polling once the stream itself gives up, gated on `streamState === 'fallback'`
  // rather than driving every answer unconditionally. Stops the moment runStatus reaches a
  // terminal value, same as the SSE path. `cancelled` drops a response that lands after this
  // effect is torn down instead of overwriting fresher state.
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

  return { answer, error, notFound };
}
