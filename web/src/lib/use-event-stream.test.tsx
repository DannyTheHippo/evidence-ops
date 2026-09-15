import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../test/fake-event-source';
import {
  CONNECTION_LABELS,
  CONNECTION_TONES,
  getStreamStatus,
  subscribeStreamStatus,
  unsubscribeStreamStatus,
  useEventStream,
  type StreamState,
} from './use-event-stream';

interface Payload {
  value: string;
}

// Tracked so a status listener a test subscribes mid-run is always unsubscribed, even on
// assertion failure — an orphaned listener would keep firing into later tests that share this
// module's status channel.
const trackedStatusListeners: Array<(state: StreamState) => void> = [];

function trackStatusListener(listener: (state: StreamState) => void): (state: StreamState) => void {
  trackedStatusListeners.push(listener);
  subscribeStreamStatus(listener);
  return listener;
}

function Harness(props: {
  url: string | null;
  onEvent: (eventName: string, data: Payload) => void;
  onFallback: () => void;
  isTerminal?: (eventName: string, data: Payload) => boolean;
}) {
  const state = useEventStream<Payload>({
    url: props.url,
    events: ['message', 'heartbeat', 'error'],
    onEvent: props.onEvent,
    onFallback: props.onFallback,
    isTerminal: props.isTerminal,
  });
  return <p>stream state: {state}</p>;
}

describe('useEventStream', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const listener of trackedStatusListeners.splice(0)) {
      unsubscribeStreamStatus(listener);
    }
  });

  it('dispatches a named event to onEvent', () => {
    const onEvent = vi.fn();
    render(<Harness url="/api/v1/answers/1/events" onEvent={onEvent} onFallback={vi.fn()} />);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('message', { value: 'hello' });
    });

    expect(onEvent).toHaveBeenCalledWith('message', { value: 'hello' });
  });

  it('closes the underlying source on a terminal event', () => {
    render(
      <Harness
        url="/api/v1/answers/1/events"
        onEvent={vi.fn()}
        onFallback={vi.fn()}
        isTerminal={(name) => name === 'message'}
      />,
    );

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('message', { value: 'done' });
    });

    expect(source.closed).toBe(true);
  });

  it('falls back immediately on a server-authored error frame', () => {
    const onFallback = vi.fn();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={onFallback} />);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('error', { value: 'server gave up' });
    });

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it('tolerates transport errors below MAX_RECONNECT_ATTEMPTS but falls back once the cap is reached', () => {
    const onFallback = vi.fn();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={onFallback} />);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emitConnectionError();
      source.emitConnectionError();
    });
    expect(onFallback).not.toHaveBeenCalled();

    act(() => {
      source.emitConnectionError();
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it('closes the source when the consuming component unmounts', () => {
    const { unmount } = render(
      <Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />,
    );

    const [source] = FakeEventSource.instances;
    expect(source.closed).toBe(false);

    unmount();

    expect(source.closed).toBe(true);
  });

  it('never constructs an EventSource when url is null', () => {
    render(<Harness url={null} onEvent={vi.fn()} onFallback={vi.fn()} />);

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.getByText('stream state: idle')).toBeInTheDocument();
  });

  it('publishes idle to a subscribed listener when a live stream unmounts', () => {
    const { unmount } = render(
      <Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />,
    );

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('message', { value: 'hi' });
    });

    const statusListener = trackStatusListener(vi.fn());
    unmount();

    expect(statusListener).toHaveBeenCalledWith('idle');
  });

  it('does not renotify a subscribed listener for a second heartbeat while already live', () => {
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('heartbeat', { value: 'first' });
    });

    const statusListener = trackStatusListener(vi.fn());
    act(() => {
      source.emit('heartbeat', { value: 'second' });
    });

    expect(statusListener).not.toHaveBeenCalled();
  });

  it('falls back on the first error once the socket has closed for good', () => {
    const onFallback = vi.fn();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={onFallback} />);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.failConnection();
    });

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it('transitions from live to stale after STALE_AFTER_MS with no further frames', async () => {
    vi.useFakeTimers();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('heartbeat', { value: 'first' });
    });
    expect(screen.getByText('stream state: live')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });

    expect(screen.getByText('stream state: stale')).toBeInTheDocument();
  });

  it('goes stale from connecting when no frame ever arrives', async () => {
    vi.useFakeTimers();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />);

    expect(screen.getByText('stream state: connecting')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });

    expect(screen.getByText('stream state: stale')).toBeInTheDocument();
  });

  it('closes a stale source and reconnects with backoff, going live on the next frame', async () => {
    vi.useFakeTimers();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />);

    const [firstSource] = FakeEventSource.instances;
    act(() => {
      firstSource.emit('heartbeat', { value: 'first' });
    });
    expect(screen.getByText('stream state: live')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(screen.getByText('stream state: stale')).toBeInTheDocument();
    expect(firstSource.closed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('stream state: reconnecting')).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(2);

    const [, secondSource] = FakeEventSource.instances;
    act(() => {
      secondSource.emit('heartbeat', { value: 'second' });
    });
    expect(screen.getByText('stream state: live')).toBeInTheDocument();
  });

  it('falls back after three stale reconnects and calls onFallback once', async () => {
    vi.useFakeTimers();
    const onFallback = vi.fn();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={onFallback} />);

    const [firstSource] = FakeEventSource.instances;
    act(() => {
      firstSource.emit('heartbeat', { value: 'first' });
    });

    // Three stale reconnects, each source left to go stale in turn with no frame ever arriving.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000 + 1_000 + 35_000 + 2_000 + 35_000 + 4_000 + 35_000);
    });

    expect(screen.getByText('stream state: fallback')).toBeInTheDocument();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(FakeEventSource.instances.every((instance) => instance.closed)).toBe(true);
  });

  it('re-establishes the stream from fallback on the timer and stops once live', async () => {
    vi.useFakeTimers();
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />);

    const [firstSource] = FakeEventSource.instances;
    act(() => {
      firstSource.emitConnectionError();
      firstSource.emitConnectionError();
      firstSource.emitConnectionError();
    });
    expect(screen.getByText('stream state: fallback')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText('stream state: reconnecting')).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(2);

    const [, secondSource] = FakeEventSource.instances;
    act(() => {
      secondSource.emit('heartbeat', { value: 'restored' });
    });
    expect(screen.getByText('stream state: live')).toBeInTheDocument();
  });

  it('re-establishes on visibilitychange to visible', () => {
    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={vi.fn()} />);

    const [firstSource] = FakeEventSource.instances;
    act(() => {
      firstSource.emitConnectionError();
      firstSource.emitConnectionError();
      firstSource.emitConnectionError();
    });
    expect(screen.getByText('stream state: fallback')).toBeInTheDocument();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(screen.getByText('stream state: reconnecting')).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('publishes idle after a terminal frame and never reconnects', async () => {
    vi.useFakeTimers();
    const onFallback = vi.fn();
    render(
      <Harness
        url="/api/v1/answers/1/events"
        onEvent={vi.fn()}
        onFallback={onFallback}
        isTerminal={(name) => name === 'message'}
      />,
    );

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('message', { value: 'done' });
    });
    expect(screen.getByText('stream state: idle')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(screen.getByText('stream state: idle')).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('carries every StreamState in CONNECTION_LABELS with no bare-word detail', () => {
    const states: StreamState[] = [
      'idle',
      'connecting',
      'live',
      'stale',
      'reconnecting',
      'fallback',
    ];

    for (const streamState of states) {
      const entry = CONNECTION_LABELS[streamState];
      expect(entry.label).toBeTruthy();
      expect(entry.detail.trim().split(/\s+/).length).toBeGreaterThan(1);
    }
  });

  it('falls back immediately when EventSource is unavailable in this environment', () => {
    vi.stubGlobal('EventSource', undefined);
    const onFallback = vi.fn();

    render(<Harness url="/api/v1/answers/1/events" onEvent={vi.fn()} onFallback={onFallback} />);

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.getByText('stream state: fallback')).toBeInTheDocument();
  });

  it('drops a malformed frame but keeps processing frames after it', () => {
    const onEvent = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Harness url="/api/v1/answers/1/events" onEvent={onEvent} onFallback={vi.fn()} />);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emitRaw('message', '{not valid json');
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    act(() => {
      source.emit('message', { value: 'recovered' });
    });
    expect(onEvent).toHaveBeenCalledWith('message', { value: 'recovered' });

    consoleErrorSpy.mockRestore();
  });

  it('publishes idle, not live, once a terminal event closes the connection', () => {
    render(
      <Harness
        url="/api/v1/answers/1/events"
        onEvent={vi.fn()}
        onFallback={vi.fn()}
        isTerminal={(name) => name === 'message'}
      />,
    );

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('message', { value: 'done' });
    });

    expect(source.closed).toBe(true);
    expect(screen.getByText('stream state: idle')).toBeInTheDocument();
    expect(getStreamStatus()).toBe('idle');
  });
});

describe('CONNECTION_TONES', () => {
  it('maps every non-idle stream state to a tone, and idle to none', () => {
    expect(CONNECTION_TONES).toEqual({
      connecting: 'connecting',
      live: 'live',
      stale: 'stale',
      reconnecting: 'reconnecting',
      fallback: 'polling',
    });
    expect(CONNECTION_TONES.idle).toBeUndefined();
  });
});
