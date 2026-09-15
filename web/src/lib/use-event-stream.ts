import { useEffect, useRef, useState } from 'react';

export type StreamState = 'idle' | 'connecting' | 'live' | 'stale' | 'reconnecting' | 'fallback';

// The browser's own SSE reconnect already retries a single dropped connection; past this many
// consecutive transport failures on the current source the hook stops waiting on it and starts
// its own stale-recovery loop instead.
const MAX_RECONNECT_ATTEMPTS = 3;

// `EventSource.readyState` after a hard transport failure (non-200 response, wrong
// `Content-Type`): the browser has given up retrying for good and will never fire another event
// on this instance. Read from the instance's own `readyState`, not the static
// `EventSource.CLOSED`, since the test double defines no statics.
const CLOSED_READY_STATE = 2;

// Every stream ticks a heartbeat every 15s (SSE_HEARTBEAT_INTERVAL_MS); this allows for two
// missed heartbeats plus margin before the recovery loop closes the source and reconnects, since
// a reconnect carries a real cost and a tighter window would flap.
const STALE_AFTER_MS = 35_000;

// Delay before each of the three explicit reconnect attempts the recovery loop makes once a
// source has gone stale or failed.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000];

// Consecutive failed reconnect attempts (a stale timeout or a bare transport error while
// `'reconnecting'`) before the loop gives up on SSE for this mount and falls back to polling.
const MAX_STALE_RECONNECTS = 3;

// How often the fallback state retries re-establishing the stream on its own, independent of the
// `visibilitychange`/`online` triggers below.
const FALLBACK_REESTABLISH_MS = 30_000;

export interface ConnectionLabel {
  label: string;
  detail: string;
}

/** The single vocabulary for every surface that shows transport state — ConnectionStatus,
 * DocumentList's status line, WorkflowRunPage's chip, AnswerWorkspace. `detail` names the next
 * action, so a state never ships as a bare word. */
export const CONNECTION_LABELS: Record<StreamState, ConnectionLabel> = {
  idle: { label: 'Idle', detail: 'Not watching for updates.' },
  connecting: { label: 'Connecting', detail: 'Opening the live channel.' },
  live: { label: 'Live', detail: 'Updating as changes arrive.' },
  stale: {
    label: 'Stale',
    detail: `No updates for ${STALE_AFTER_MS / 1000} seconds — reconnecting.`,
  },
  reconnecting: { label: 'Reconnecting', detail: 'Reopening the live channel.' },
  fallback: { label: 'Polling', detail: 'Live channel unavailable — refreshing on a timer.' },
};

export type ConnectionTone = 'live' | 'connecting' | 'stale' | 'reconnecting' | 'polling';

/** Tone class suffix for every `StreamState` a connection dot renders — the vocabulary
 * `ConnectionStatus` and `AnswerWorkspace` both share. `fallback` reads as `'polling'` since the
 * recovery loop has given up on SSE for now and is refreshing on a timer; `reconnecting` keeps its
 * own tone so a mid-recovery attempt reads differently from a stream that has already given up.
 * `'idle'` carries no tone — a page holding no stream renders no dot. */
export const CONNECTION_TONES: Partial<Record<StreamState, ConnectionTone>> = {
  connecting: 'connecting',
  live: 'live',
  stale: 'stale',
  reconnecting: 'reconnecting',
  fallback: 'polling',
};

type StreamStatusListener = (state: StreamState) => void;

let currentStreamStatus: StreamState = 'idle';
const streamStatusListeners = new Set<StreamStatusListener>();

// Module-scope publish/subscribe, mirroring auth.ts's module-scope session cache: a component
// outside the hook's own tree (the top bar's connection indicator) can read and react to the
// status of whichever stream is currently mounted without a context provider.
export function subscribeStreamStatus(listener: StreamStatusListener): void {
  streamStatusListeners.add(listener);
}

export function unsubscribeStreamStatus(listener: StreamStatusListener): void {
  streamStatusListeners.delete(listener);
}

export function publishStreamStatus(state: StreamState): void {
  if (state === currentStreamStatus) return;
  currentStreamStatus = state;
  for (const listener of streamStatusListeners) listener(state);
}

export function getStreamStatus(): StreamState {
  return currentStreamStatus;
}

interface UseEventStreamOptions<T> {
  url: string | null;
  events: readonly string[];
  onEvent: (eventName: string, data: T) => void;
  onFallback: () => void;
  isTerminal?: (eventName: string, data: T) => boolean;
}

interface EventStreamCallbacks<T> {
  events: readonly string[];
  onEvent: (eventName: string, data: T) => void;
  onFallback: () => void;
  isTerminal?: (eventName: string, data: T) => boolean;
}

// Which reconnect strategy the current source's error handler is attached under: `'initial'`
// counts bare transport errors toward `MAX_RECONNECT_ATTEMPTS` (the browser's own retry, given
// some slack); `'backoff-reconnect'` and `'fallback-reestablish'` both treat any failure as a
// failed recovery attempt, handled by `handleFailure` and `goFallback` respectively.
type ConnectionPhase = 'initial' | 'backoff-reconnect' | 'fallback-reestablish';

/**
 * Subscribes to a named-event SSE endpoint and returns its connection status. `url: null`
 * disables the stream entirely — no `EventSource` is ever constructed. A stale source (no named
 * frame for `STALE_AFTER_MS`) is closed and replaced: the hook publishes `'stale'`, waits
 * `RECONNECT_BACKOFF_MS[n]`, publishes `'reconnecting'` and opens a fresh `EventSource` with every
 * handler re-attached. After `MAX_STALE_RECONNECTS` failed attempts it publishes `'fallback'` and
 * calls `onFallback()`; from `'fallback'` a 30s timer, `document` becoming visible, and the
 * browser going `online` each start one more reconnect attempt, returning to `'fallback'` and
 * calling `onFallback()` again on failure. A terminal event (per `isTerminal`) closes the
 * connection itself and publishes `'idle'`, since `EventSource` otherwise treats even a clean
 * server-side completion as a dropped connection and reopens it, and a closed connection must
 * never keep reporting `'live'`. The named `error` event and the transport-level error event
 * share the same name on `EventSource`; a server-authored frame arrives as a `MessageEvent` (has
 * `.data`) and gives up immediately, as does a `readyState` the browser has marked `CLOSED` for
 * good. A frame whose payload fails to parse as JSON is dropped: the connection stays open and
 * neither `onEvent` nor the status advances for that frame, but the drop itself is logged so it
 * never disappears silently.
 */
export function useEventStream<T>(options: UseEventStreamOptions<T>): StreamState {
  const [state, setState] = useState<StreamState>(options.url ? 'connecting' : 'idle');

  const callbacksRef = useRef<EventStreamCallbacks<T>>({
    events: options.events,
    onEvent: options.onEvent,
    onFallback: options.onFallback,
    isTerminal: options.isTerminal,
  });

  // Refreshed every render so the connection effect below never closes over a stale callback,
  // keeping its own dependency array honestly at [options.url].
  useEffect(() => {
    callbacksRef.current = {
      events: options.events,
      onEvent: options.onEvent,
      onFallback: options.onFallback,
      isTerminal: options.isTerminal,
    };
  });

  useEffect(() => {
    // Mirrors `state` outside React so the stale-check timeout can read "is this still live"
    // without a `setState` updater — an updater must stay pure, and StrictMode double-invokes it,
    // which would double-publish here.
    let localState: StreamState = options.url ? 'connecting' : 'idle';

    const setAndPublish = (next: StreamState) => {
      localState = next;
      setState(next);
      publishStreamStatus(next);
    };

    if (!options.url) {
      setAndPublish('idle');
      return;
    }

    if (typeof EventSource === 'undefined') {
      setAndPublish('fallback');
      callbacksRef.current.onFallback();
      return;
    }

    // Narrowed once, outside `connect`, since a nested closure does not inherit the null check
    // above — `options.url` itself is still typed `string | null` inside a function body defined
    // later in this effect.
    const url = options.url;

    let source: EventSource | undefined;
    let namedHandlers: Array<{ name: string; handler: (event: Event) => void }> = [];
    let errorHandler: ((event: Event) => void) | undefined;
    let phase: ConnectionPhase = 'initial';
    let bareErrorCount = 0;
    let reconnectsMade = 0;

    let staleTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let backoffTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimeoutId: ReturnType<typeof setTimeout> | undefined;

    const clearStaleTimer = () => {
      if (staleTimeoutId !== undefined) clearTimeout(staleTimeoutId);
      staleTimeoutId = undefined;
    };

    const clearBackoffTimer = () => {
      if (backoffTimeoutId !== undefined) clearTimeout(backoffTimeoutId);
      backoffTimeoutId = undefined;
    };

    const clearFallbackTimer = () => {
      if (fallbackTimeoutId !== undefined) clearTimeout(fallbackTimeoutId);
      fallbackTimeoutId = undefined;
    };

    const detachSource = () => {
      if (!source) return;
      if (errorHandler) source.removeEventListener('error', errorHandler);
      for (const { name, handler } of namedHandlers) source.removeEventListener(name, handler);
      source.close();
      source = undefined;
      namedHandlers = [];
      errorHandler = undefined;
    };

    const scheduleStaleCheck = () => {
      clearStaleTimer();
      staleTimeoutId = setTimeout(handleFailure, STALE_AFTER_MS);
    };

    const scheduleFallbackReestablish = () => {
      clearFallbackTimer();
      fallbackTimeoutId = setTimeout(attemptReestablishFromFallback, FALLBACK_REESTABLISH_MS);
    };

    const goFallback = () => {
      clearStaleTimer();
      clearBackoffTimer();
      detachSource();
      reconnectsMade = 0;
      phase = 'initial';
      setAndPublish('fallback');
      callbacksRef.current.onFallback();
      scheduleFallbackReestablish();
    };

    const handleFailure = () => {
      clearStaleTimer();
      detachSource();
      setAndPublish('stale');

      if (phase === 'fallback-reestablish') {
        goFallback();
        return;
      }

      if (reconnectsMade >= MAX_STALE_RECONNECTS) {
        goFallback();
        return;
      }

      const delay = RECONNECT_BACKOFF_MS[reconnectsMade];
      reconnectsMade += 1;
      phase = 'backoff-reconnect';
      clearBackoffTimer();
      backoffTimeoutId = setTimeout(() => {
        setAndPublish('reconnecting');
        connect();
      }, delay);
    };

    const attemptReestablishFromFallback = () => {
      clearFallbackTimer();
      phase = 'fallback-reestablish';
      setAndPublish('reconnecting');
      connect();
    };

    const handleVisibilityChange = () => {
      if (localState === 'fallback' && document.visibilityState === 'visible') {
        attemptReestablishFromFallback();
      }
    };

    const handleOnline = () => {
      if (localState === 'fallback') attemptReestablishFromFallback();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    const connect = () => {
      const newSource = new EventSource(url);
      source = newSource;
      bareErrorCount = 0;

      const handleError = (event: Event) => {
        if ('data' in event) {
          goFallback();
          return;
        }
        if (newSource.readyState === CLOSED_READY_STATE) {
          goFallback();
          return;
        }
        if (phase !== 'initial') {
          handleFailure();
          return;
        }
        bareErrorCount += 1;
        if (bareErrorCount >= MAX_RECONNECT_ATTEMPTS) {
          goFallback();
        }
      };
      newSource.addEventListener('error', handleError);
      errorHandler = handleError;

      namedHandlers = callbacksRef.current.events
        .filter((name) => name !== 'error')
        .map((name) => {
          const handler = (event: Event) => {
            let data: T;
            try {
              data = JSON.parse((event as MessageEvent<string>).data) as T;
            } catch (error) {
              // A truncated or malformed frame must not kill the listener for every frame after
              // it — the connection stays open and this one frame is skipped, not the stream.
              console.error(`useEventStream: dropped malformed "${name}" frame`, error);
              return;
            }
            bareErrorCount = 0;
            reconnectsMade = 0;
            phase = 'initial';
            scheduleStaleCheck();
            setAndPublish('live');
            callbacksRef.current.onEvent(name, data);
            if (callbacksRef.current.isTerminal?.(name, data)) {
              clearStaleTimer();
              clearBackoffTimer();
              clearFallbackTimer();
              detachSource();
              setAndPublish('idle');
            }
          };
          newSource.addEventListener(name, handler);
          return { name, handler };
        });

      scheduleStaleCheck();
    };

    setAndPublish('connecting');
    connect();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      clearStaleTimer();
      clearBackoffTimer();
      clearFallbackTimer();
      detachSource();
      // A page holding no stream must not leave the last-known status behind — the connection
      // indicator otherwise keeps reporting this stream's last state after navigating away from it.
      publishStreamStatus('idle');
    };
  }, [options.url]);

  return state;
}
