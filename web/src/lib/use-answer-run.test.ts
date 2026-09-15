import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '../api/client';
import { FakeEventSource } from '../test/fake-event-source';
import { useAnswerRun } from './use-answer-run';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: 'answer-1',
    questionText: 'What is the cap rate?',
    runStatus: 'running',
    citations: [],
    conflictIds: [],
    createdAt: new Date().toISOString(),
    atoms: [],
    withdrawnCitedDocVersionIds: [],
    ...overrides,
  };
}

describe('useAnswerRun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fetches the answer by id when no initialAnswer is supplied', async () => {
    const answer = baseAnswer({ runStatus: 'completed' });
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers/answer-1') return Promise.resolve(jsonResponse(answer));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAnswerRun({ answerId: 'answer-1' }));

    await waitFor(() => expect(result.current.answer).toEqual(answer));
  });

  it('seeds from initialAnswer instead of fetching, for a caller that already has the snapshot', async () => {
    const seed = baseAnswer({ runStatus: 'queued' });
    const fetchMock = vi.fn((url: string) => Promise.reject(new Error(`Unexpected fetch: ${url}`)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAnswerRun({ answerId: seed.id, initialAnswer: seed }));

    await waitFor(() => expect(result.current.answer).toEqual(seed));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves notFound on a 404, not a generic error, and never starts polling a dead id', async () => {
    // No `EventSource` at all — this environment falls back to polling from the first render, so
    // an id that 404s must stop that poll loop too, not just the initial GET. Real timers here (a
    // short `pollIntervalMs`, not fake-timer advancing): a wrongly-scheduled poll gets a genuine
    // chance to fire before the assertion below, rather than racing fake-timer tick ordering
    // against the 404 response's own promise chain.
    vi.stubGlobal('EventSource', undefined);
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: "Answer 'answer-1' not found" }, 404)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAnswerRun({ answerId: 'answer-1', pollIntervalMs: 40 }));

    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.error).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-404 load failure as error', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'Answer unavailable' }, 500)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAnswerRun({ answerId: 'answer-1' }));

    await waitFor(() => expect(result.current.error).toBe('Answer unavailable'));
  });

  it('applies a named answer event over SSE and closes the source on a terminal one', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const seed = baseAnswer({ runStatus: 'queued' });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.reject(new Error(`Unexpected fetch: ${url}`))),
    );

    const { result } = renderHook(() => useAnswerRun({ answerId: seed.id, initialAnswer: seed }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const [source] = FakeEventSource.instances;
    expect(source.url).toBe('/api/v1/answers/answer-1/events');

    const completed = { ...seed, runStatus: 'completed' as const };
    act(() => {
      source.emit('answer', completed);
    });

    await waitFor(() => expect(result.current.answer).toEqual(completed));
    expect(source.closed).toBe(true);
  });

  it('reports the transport state alongside the answer', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const seed = baseAnswer({ runStatus: 'queued' });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.reject(new Error(`Unexpected fetch: ${url}`))),
    );

    const { result } = renderHook(() => useAnswerRun({ answerId: seed.id, initialAnswer: seed }));

    expect(result.current.streamState).toBe('connecting');

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const [source] = FakeEventSource.instances;

    act(() => {
      source.emit('answer', { ...seed, runStatus: 'running' as const });
    });

    await waitFor(() => expect(result.current.streamState).toBe('live'));
  });

  it('keeps carrying the run to a terminal state by polling once the stream falls back', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const seed = baseAnswer({ runStatus: 'queued' });
    const completed = { ...seed, runStatus: 'completed' as const };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers/answer-1') return Promise.resolve(jsonResponse(completed));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useAnswerRun({ answerId: seed.id, initialAnswer: seed, pollIntervalMs: 5 }),
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const [source] = FakeEventSource.instances;

    // Models the API's own 30-minute stream ceiling ending the connection out from under the
    // browser's retry budget — from this hook's point of view, indistinguishable from a hard
    // transport failure: readyState CLOSED before `error` fires.
    act(() => {
      source.failConnection();
    });

    await waitFor(() => expect(result.current.answer).toEqual(completed));
  });

  it('clears a stale error once a newer snapshot lands', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'Answer unavailable' }, 500)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAnswerRun({ answerId: 'answer-1' }));

    await waitFor(() => expect(result.current.error).toBe('Answer unavailable'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const [source] = FakeEventSource.instances;
    const fresh = baseAnswer({ runStatus: 'running' });

    act(() => {
      source.emit('answer', fresh);
    });

    await waitFor(() => {
      expect(result.current.answer).toEqual(fresh);
      expect(result.current.error).toBeNull();
    });
  });

  it('backs off after a failed poll and never overlaps requests', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
    const seed = baseAnswer({ runStatus: 'queued' });
    const completed = { ...seed, runStatus: 'completed' as const };
    let calls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url !== '/api/v1/answers/answer-1') {
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      }
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse({ message: 'Poll failed' }, 500));
      return Promise.resolve(jsonResponse(completed));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useAnswerRun({ answerId: seed.id, initialAnswer: seed, pollIntervalMs: 10 }),
    );

    // The source is constructed synchronously during mount — asserted directly rather than
    // through `waitFor`, whose own real-time polling never resolves once fake timers are active.
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => {
      FakeEventSource.instances[0].failConnection();
    });

    // First attempt fires at the base interval and fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toBe(1);
    expect(result.current.error).toBe('Poll failed');

    // The retry is backed off to double the interval — nothing new at the original cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toBe(2);
    expect(result.current.answer).toEqual(completed);
    expect(result.current.error).toBeNull();
  });
});
