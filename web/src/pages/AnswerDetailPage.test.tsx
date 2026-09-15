import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import { getBreadcrumbTrail } from '../lib/breadcrumbs';
import { truncateSha256 } from '../lib/identifiers';
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

// A minimal bundle satisfying `AttestationBundleView`'s render — the fields under test here never
// exercise its claim/decision rendering, only that the section mounts.
function attestationResponse(subjectId: string, question: string): Response {
  return jsonResponse({
    schemaVersion: 1,
    kind: 'answer',
    subjectId,
    tenantId: 't',
    producedAt: new Date().toISOString(),
    subject: { question },
    outcome: 'insufficient_evidence',
    claims: [],
    decisions: [],
    measures: [],
    integrity: { algorithm: 'sha256', contentHash: 'abc' },
  });
}

// Dispatches by URL rather than answering every call with the answer body — once the answer is
// completed, AttestationBundleView also fetches its own `/attestation` and
// `/documents/versions/lookup`, and a catch-all stub would answer those with the answer body too.
function mockAnswerFetch(answer: { id: string; questionText: string }) {
  return vi.fn((url: string) => {
    if (url === `/api/v1/answers/${answer.id}/attestation`) {
      return Promise.resolve(attestationResponse(answer.id, answer.questionText));
    }
    if (url.startsWith('/api/v1/documents/versions/lookup')) {
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    }
    return Promise.resolve(jsonResponse(answer));
  });
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
    // The loading skeleton itself is gone — a CopyButton's own visually-hidden announcement
    // region also carries `role="status"` once the answer's meta row mounts, so this checks for
    // the loading label specifically rather than the absence of every status role.
    expect(screen.queryByText('Loading answer…')).not.toBeInTheDocument();
  });

  it('renders a completed answer through AnswerView', async () => {
    vi.stubGlobal('fetch', mockAnswerFetch(completedAnswer));

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
      screen.getByText('Still answering — this page updates as the run progresses.'),
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
        const url = typeof input === 'string' ? input : '';
        if (url === '/api/v1/answers/answer-1') return first.promise;
        if (url === '/api/v1/answers/answer-1/attestation') {
          return Promise.resolve(attestationResponse('answer-1', answerOne.questionText));
        }
        if (url === '/api/v1/answers/answer-2') return Promise.resolve(jsonResponse(answerTwo));
        if (url === '/api/v1/answers/answer-2/attestation') {
          return Promise.resolve(attestationResponse('answer-2', answerTwo.questionText));
        }
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
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

  it('renders the asked timestamp, short id, and a copy control once the answer loads', async () => {
    vi.stubGlobal('fetch', mockAnswerFetch(completedAnswer));

    renderAt('answer-1');

    expect(await screen.findByText(/Asked/)).toBeInTheDocument();
    expect(screen.getByText('answer-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy id' })).toBeInTheDocument();
  });

  it('offers Back to answers and Ask a follow-up from the header actions', async () => {
    vi.stubGlobal('fetch', mockAnswerFetch(completedAnswer));

    renderAt('answer-1');
    await screen.findByText('No document mentions the cap rate.');

    expect(screen.getByRole('link', { name: 'Back to answers' })).toHaveAttribute(
      'href',
      '/answers',
    );
    expect(screen.getByRole('link', { name: 'Ask a follow-up' })).toHaveAttribute(
      'href',
      `/answers?q=${encodeURIComponent(completedAnswer.questionText)}`,
    );
  });

  it('offers a link back to the list from the not-found empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: "Answer 'answer-1' not found" }, 404)),
    );

    renderAt('answer-1');

    expect(await screen.findByText('Answer not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all answers' })).toHaveAttribute(
      'href',
      '/answers',
    );
  });

  it('publishes the Answers › question breadcrumb trail once the answer loads', async () => {
    vi.stubGlobal('fetch', mockAnswerFetch(completedAnswer));

    renderAt('answer-1');
    await screen.findByText('No document mentions the cap rate.');

    // useBreadcrumbs publishes from its own effect, one tick after the render that painted the
    // outcome above (App.test.tsx's document.title assertion documents the same lag).
    await waitFor(() => {
      expect(getBreadcrumbTrail()).toEqual([
        { label: 'Answers', to: '/answers' },
        { label: 'What is the cap rate?' },
      ]);
    });
  });

  it('clamps a long question in the breadcrumb', async () => {
    const longQuestion = `${'What is the cap rate for the property at '.repeat(3)}the corner?`;
    const longAnswer = { ...completedAnswer, questionText: longQuestion };
    vi.stubGlobal('fetch', mockAnswerFetch(longAnswer));

    renderAt('answer-1');
    // The PageHeader title keeps the full text — only the published crumb clamps.
    await screen.findByRole('heading', { name: longQuestion });

    await waitFor(() => {
      expect(getBreadcrumbTrail()).toEqual([
        { label: 'Answers', to: '/answers' },
        { label: `${longQuestion.slice(0, 60)}…` },
      ]);
    });
  });

  it('carries the question into the follow-up link', async () => {
    const failedAnswer = {
      id: 'answer-1',
      questionText: 'What is the cap rate?',
      runStatus: 'failed',
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(failedAnswer)));

    renderAt('answer-1');

    expect(await screen.findByRole('link', { name: 'Ask a follow-up' })).toHaveAttribute(
      'href',
      `/answers?q=${encodeURIComponent('What is the cap rate?')}`,
    );
    expect(screen.queryByRole('link', { name: 'Ask this question again' })).not.toBeInTheDocument();
  });

  it('renders the answerPath badge and the attestation hash chip once the answer loads', async () => {
    const ledgerAnswer = {
      ...completedAnswer,
      answerPath: 'ledger',
      attestationHash: 'a'.repeat(64),
    };
    vi.stubGlobal('fetch', mockAnswerFetch(ledgerAnswer));

    renderAt('answer-1');
    await screen.findByText('No document mentions the cap rate.');

    expect(screen.getByText('ledger')).toBeInTheDocument();
    expect(screen.getByTitle('a'.repeat(64))).toHaveTextContent(truncateSha256('a'.repeat(64)));
  });

  it('does not render the answerPath badge or the hash chip when neither is present', async () => {
    vi.stubGlobal('fetch', mockAnswerFetch(completedAnswer));

    renderAt('answer-1');
    await screen.findByText('No document mentions the cap rate.');

    expect(screen.queryByText('ledger')).not.toBeInTheDocument();
    expect(screen.queryByText('synthesis')).not.toBeInTheDocument();
  });

  it('renders the attestation section only once the run has completed', async () => {
    vi.stubGlobal('fetch', mockAnswerFetch(completedAnswer));

    renderAt('answer-1');

    expect(await screen.findByRole('heading', { name: 'Attestation' })).toBeInTheDocument();
  });

  it('does not auto-generate an attestation for an answer with no pinned hash', async () => {
    const fetchMock = mockAnswerFetch(completedAnswer);
    vi.stubGlobal('fetch', fetchMock);

    renderAt('answer-1');

    expect(await screen.findByRole('button', { name: 'Generate attestation' })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === `/api/v1/answers/${completedAnswer.id}/attestation`,
      ),
    ).toBe(false);
  });

  it('auto-loads the attestation bundle when the answer already carries a pinned hash', async () => {
    const ledgerAnswer = { ...completedAnswer, attestationHash: 'a'.repeat(64) };
    vi.stubGlobal('fetch', mockAnswerFetch(ledgerAnswer));

    renderAt('answer-1');

    expect(await screen.findByRole('heading', { name: 'Attested claims' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Download attestation' })).toBeInTheDocument();
  });

  it('does not render the attestation section for a run still in flight', async () => {
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

    await screen.findByText('running');
    expect(screen.queryByRole('heading', { name: 'Attestation' })).not.toBeInTheDocument();
  });
});
