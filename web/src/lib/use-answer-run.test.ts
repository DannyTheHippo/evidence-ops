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
    withdrawnCitedDocVersionIds: [],
    ...overrides,
  };
}

describe('useAnswerRun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('resolves notFound on a 404, not a generic error', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: "Answer 'answer-1' not found" }, 404)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAnswerRun({ answerId: 'answer-1' }));

    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.error).toBeNull();
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
});
