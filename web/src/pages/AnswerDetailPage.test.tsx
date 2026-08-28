import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import { FakeEventSource } from '../test/fake-event-source';
import AnswerDetailPage from './AnswerDetailPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const completedAnswer = {
  id: 'answer-1',
  questionText: 'What is the cap rate?',
  runStatus: 'completed',
  outcome: {
    kind: 'insufficient_evidence',
    reason: 'No document mentions the cap rate.',
  },
  citations: [],
  conflictIds: [],
  createdAt: new Date().toISOString(),
};

function renderAt(id: string, pollIntervalMs?: number) {
  render(
    <MemoryRouter initialEntries={[`/answers/${id}`]}>
      <Routes>
        <Route path="/answers/:id" element={<AnswerDetailPage pollIntervalMs={pollIntervalMs} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AnswerDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('shows a loading state before the answer arrives', async () => {
    let resolveAnswer: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveAnswer = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));

    renderAt('answer-1');

    expect(screen.getByRole('status')).toHaveTextContent('Loading answer…');

    resolveAnswer!(jsonResponse(completedAnswer));

    expect(await screen.findByText('No document mentions the cap rate.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders a completed answer through AnswerView', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completedAnswer)));

    renderAt('answer-1');

    expect(
      await screen.findByRole('heading', { name: 'What is the cap rate?' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No document mentions the cap rate.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the run status for an answer still in flight, not an empty page', async () => {
    const runningAnswer = {
      id: 'answer-2',
      questionText: 'What is the vacancy rate?',
      runStatus: 'running',
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(runningAnswer)));

    renderAt('answer-2');

    expect(await screen.findByText('running')).toBeInTheDocument();
    expect(
      screen.getByText('Still answering — check back once this run completes.'),
    ).toBeInTheDocument();
  });

  it('shows "Answer not found" for a 404, not the generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: "Answer 'answer-1' not found" }, 404)),
    );

    renderAt('answer-1');

    expect(await screen.findByText('Answer not found.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the load error for a non-404 failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Answer unavailable' }, 500)),
    );

    renderAt('answer-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Answer unavailable');
  });

  it('does not render a stale answer that resolves after navigating to a different answer', async () => {
    const first = deferred<Response>();
    const answerOne = { ...completedAnswer, id: 'answer-1', questionText: 'First question' };
    const answerTwo = {
      ...completedAnswer,
      id: 'answer-2',
      questionText: 'Second question',
      outcome: { kind: 'insufficient_evidence', reason: 'No document mentions the vacancy rate.' },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const isFirst = typeof input === 'string' && input.includes('/answers/answer-1');
        return isFirst ? first.promise : Promise.resolve(jsonResponse(answerTwo));
      }),
    );

    render(
      <MemoryRouter initialEntries={['/answers/answer-1']}>
        <Link to="/answers/answer-2">Go to second answer</Link>
        <Routes>
          <Route path="/answers/:id" element={<AnswerDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('status')).toHaveTextContent('Loading answer…');

    fireEvent.click(screen.getByText('Go to second answer'));

    expect(await screen.findByText('No document mentions the vacancy rate.')).toBeInTheDocument();

    // The first answer's request finally settles after navigation moved to the second answer —
    // its `id`-keyed effect was already cleaned up, so this must not overwrite what's rendered.
    first.resolve(jsonResponse(answerOne));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole('heading', { name: 'First question' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Second question' })).toBeInTheDocument();
  });

  it('streams a still-running answer to completion over SSE, closing the source on the terminal event', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);

    const runningAnswer = {
      id: 'answer-3',
      questionText: 'What is the vacancy rate?',
      runStatus: 'running',
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers/answer-3') return Promise.resolve(jsonResponse(runningAnswer));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('answer-3');

    expect(await screen.findByText('running')).toBeInTheDocument();

    // The stream is opened by a passive effect that flushes after the commit — waiting for the
    // instance is what makes this deterministic (see use-event-stream.ts's own doc comment).
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const [source] = FakeEventSource.instances;
    expect(source.url).toBe('/api/v1/answers/answer-3/events');

    act(() => {
      source.emit('answer', {
        ...runningAnswer,
        runStatus: 'completed',
        outcome: {
          kind: 'insufficient_evidence',
          reason: 'No document mentions the vacancy rate.',
        },
      });
    });

    expect(await screen.findByText('No document mentions the vacancy rate.')).toBeInTheDocument();
    expect(source.closed).toBe(true);
  });

  it('keeps carrying a run to its terminal state by polling once the stream falls back', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);

    const runningAnswer = {
      id: 'answer-3',
      questionText: 'What is the vacancy rate?',
      runStatus: 'running',
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
    };
    const completedAnswer = {
      ...runningAnswer,
      runStatus: 'completed',
      outcome: { kind: 'insufficient_evidence', reason: 'No document mentions the vacancy rate.' },
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers/answer-3') return Promise.resolve(jsonResponse(completedAnswer));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('answer-3', 5);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const [source] = FakeEventSource.instances;

    // The API's own 30-minute stream ceiling ends the connection the same way a hard transport
    // failure does from this hook's point of view — readyState CLOSED before `error` fires.
    act(() => {
      source.failConnection();
    });

    expect(await screen.findByText('No document mentions the vacancy rate.')).toBeInTheDocument();
  });
});
