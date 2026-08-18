import { useEffect, useRef, useState } from 'react';

export type StreamState = 'idle' | 'connecting' | 'live' | 'stale' | 'fallback';

// The browser's own SSE reconnect already retries a single dropped connection; past this many
// consecutive transport failures the hook stops waiting on it and falls back to polling instead.
const MAX_RECONNECT_ATTEMPTS = 3;

// `EventSource.readyState` after a hard transport failure (non-200 response, wrong
// `Content-Type`): the browser has given up retrying for good and will never fire another event
// on this instance. Read from the instance's own `readyState`, not the static
// `EventSource.CLOSED`, since the test double defines no statics.
const CLOSED_READY_STATE = 2;

// Every stream ticks a heartbeat every 15s; this adds margin so one delayed tick does not flip
// the status before the next one has a chance to land.
const STALE_AFTER_MS = 20_000;

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

/**
 * Subscribes to a named-event SSE endpoint and returns its connection status. `url: null`
 * disables the stream entirely — no `EventSource` is ever constructed. A terminal event (per
 * `isTerminal`) closes the connection itself and publishes `'idle'`, since `EventSource`
 * otherwise treats even a clean server-side completion as a dropped connection and reopens it,
 * and a closed connection must never keep reporting `'live'`. The named `error` event and the
 * transport-level error event share the same name on `EventSource`; a server-authored frame
 * arrives as a `MessageEvent` (has `.data`) and gives up immediately. A bare transport `Event`
 * (no `.data`) means either a retryable blip — left to the browser's own retry up to
 * `MAX_RECONNECT_ATTEMPTS` — or a hard failure (non-200 response, wrong `Content-Type`) that the
 * browser marks `readyState = CLOSED` and never retries; that case falls back immediately rather
 * than waiting on a retry count that would never reach the cap. A frame whose payload fails to
 * parse as JSON is dropped: the connection stays open and neither `onEvent` nor the status
 * advances for that frame, but the drop itself is logged so it never disappears silently.
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

    setAndPublish('connecting');
    const source = new EventSource(options.url);
    let reconnectAttempts = 0;
    let staleTimeoutId: ReturnType<typeof setTimeout> | undefined;

    const clearStaleTimer = () => {
      if (staleTimeoutId !== undefined) clearTimeout(staleTimeoutId);
    };

    const scheduleStaleCheck = () => {
      clearStaleTimer();
      staleTimeoutId = setTimeout(() => {
        if (localState === 'live') {
          setAndPublish('stale');
        }
      }, STALE_AFTER_MS);
    };

    const fallback = () => {
      clearStaleTimer();
      source.close();
      setAndPublish('fallback');
      callbacksRef.current.onFallback();
    };

    const handleError = (event: Event) => {
      if ('data' in event) {
        fallback();
        return;
      }
      if (source.readyState === CLOSED_READY_STATE) {
        fallback();
        return;
      }
      reconnectAttempts += 1;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        fallback();
      }
    };

    source.addEventListener('error', handleError);

    const namedHandlers = callbacksRef.current.events
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
          reconnectAttempts = 0;
          scheduleStaleCheck();
          setAndPublish('live');
          callbacksRef.current.onEvent(name, data);
          if (callbacksRef.current.isTerminal?.(name, data)) {
            clearStaleTimer();
            source.close();
            setAndPublish('idle');
          }
        };
        source.addEventListener(name, handler);
        return { name, handler };
      });

    return () => {
      clearStaleTimer();
      source.removeEventListener('error', handleError);
      for (const { name, handler } of namedHandlers) {
        source.removeEventListener(name, handler);
      }
      source.close();
      // A page holding no stream must not leave the last-known status behind — the connection
      // indicator otherwise keeps reporting this stream's last state after navigating away from it.
      publishStreamStatus('idle');
    };
  }, [options.url]);

  return state;
}
