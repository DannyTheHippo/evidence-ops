import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../test/fake-event-source';
import AskPage from './AskPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A fetch response the test releases by hand, so an in-flight poll can be made to land after a
// later one — the ordering a wall-clock delay can only approximate.
function deferredResponse(body: unknown): { response: Promise<Response>; release: () => void } {
  let release!: () => void;
  const response = new Promise<Response>((resolve) => {
    release = () => resolve(jsonResponse(body));
  });
  return { response, release };
}

function ask(question: string) {
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('AskPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders insufficient_evidence as a valid answer, not an error', async () => {
    const completedAnswer = {
      id: 'answer-1',
      questionText: 'What is the vacancy rate?',
      runStatus: 'completed',
      outcome: {
        kind: 'insufficient_evidence',
        reason: 'No document in the corpus mentions vacancy.',
      },
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
    };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'answer-1', runStatus: 'queued' }, 201));
    // A Response body reads once. The catch-all builds a fresh one per call so a second poll
    // deserialises the answer again instead of throwing on a consumed body.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(completedAnswer)));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('What is the vacancy rate?');

    await screen.findByText('No document in the corpus mentions vacancy.');

    expect(screen.getByText('insufficient evidence')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a conflict badge on a conflicting_evidence answer, resolving sources to titles and falling back to the raw id for an unmatched chunk', async () => {
    const completedAnswer = {
      id: 'answer-2',
      questionText: 'What is the cap rate?',
      runStatus: 'completed',
      outcome: {
        kind: 'conflicting_evidence',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-a' },
          { value: 6.4, unit: 'percent', sourceChunkId: 'chunk-c' },
        ],
      },
      citations: [],
      conflictIds: ['conflict-1'],
      createdAt: new Date().toISOString(),
    };

    const documentVersion = {
      id: 'docver-1',
      versionNumber: 1,
      sha256: 'abc',
      sizeBytes: 10,
      ingestionStatus: 'completed',
      createdAt: new Date().toISOString(),
    };
    const document = {
      id: 'doc-1',
      title: 'Rent Roll Q1',
      sourceKind: 'pdf',
      mimeType: 'application/pdf',
      currentVersion: documentVersion,
      createdAt: new Date().toISOString(),
    };
    const conflicts = {
      docs: [
        {
          id: 'conflict-1',
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
          factIds: ['fact-a'],
          values: [
            {
              factId: 'fact-a',
              value: 6.1,
              unit: 'percent',
              sourceChunkId: 'chunk-a',
              documentVersionId: 'docver-1',
              locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
            },
          ],
          magnitude: 0.003,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      ],
      count: 1,
    };

    // Three interleaved fetch families (answer poll, document index, conflicts) land here, so the
    // stub dispatches by URL rather than by call order.
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/questions') {
        return Promise.resolve(jsonResponse({ id: 'answer-2', runStatus: 'queued' }, 201));
      }
      if (url === '/api/v1/answers/answer-2') return Promise.resolve(jsonResponse(completedAnswer));
      if (url === '/api/v1/documents') {
        return Promise.resolve(jsonResponse({ docs: [document], count: 1 }));
      }
      if (url === '/api/v1/documents/doc-1') {
        return Promise.resolve(jsonResponse({ ...document, versions: [documentVersion] }));
      }
      if (url === '/api/v1/conflicts?limit=100') return Promise.resolve(jsonResponse(conflicts));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('What is the cap rate?');

    await screen.findByText('conflicting evidence');

    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(screen.getByText('6.4 percent')).toBeInTheDocument();
    expect(await screen.findByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
    expect(screen.getByText('chunk-c')).toBeInTheDocument();
  });

  it('stops polling once runStatus reaches completed', async () => {
    const runningAnswer = {
      id: 'answer-3',
      questionText: 'Q',
      runStatus: 'running',
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
    };
    const completedAnswer = {
      ...runningAnswer,
      runStatus: 'completed',
      outcome: { kind: 'insufficient_evidence', reason: 'Not enough evidence.' },
    };
    // Never a legitimate response — only a poll issued after the answer completed can reach it,
    // so it stands in for the state a leaked interval would push into the page.
    const poisonedAnswer = { ...runningAnswer, runStatus: 'failed', outcome: undefined };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'answer-3', runStatus: 'queued' }, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(runningAnswer));
    fetchMock.mockResolvedValueOnce(jsonResponse(completedAnswer));
    // Fresh Response per call: a single shared one is readable only once, so repeated polls would
    // fail on a consumed body instead of deserialising the fixture.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(poisonedAnswer)));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('Q');

    await screen.findByText('Not enough evidence.');

    // Assert the poll count stops growing rather than that the poisoned response fails to render:
    // with a short interval several polls are in flight before React re-renders, so a
    // render-based assertion races the teardown and fails intermittently. Call count is the
    // property actually under test — "the interval was cleared" — and it is deterministic.
    const pollCalls = () =>
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/answers/answer-3').length;
    const callsAtCompletion = pollCalls();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(pollCalls()).toBe(callsAtCompletion);
  });

  it('drops a poll response that lands after a later one already completed the answer', async () => {
    const completedAnswer = {
      id: 'answer-4',
      questionText: 'Q',
      runStatus: 'completed',
      outcome: { kind: 'insufficient_evidence', reason: 'Not enough evidence.' },
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
    };
    // The first poll's own response, held back until after a later poll reported completion.
    // Applying it would walk the page backwards from a settled answer to a failed run.
    const stale = deferredResponse({ ...completedAnswer, runStatus: 'failed', outcome: undefined });

    let pollCall = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/questions') {
        return Promise.resolve(jsonResponse({ id: 'answer-4', runStatus: 'queued' }, 201));
      }
      if (url === '/api/v1/answers/answer-4') {
        pollCall += 1;
        return pollCall === 1 ? stale.response : Promise.resolve(jsonResponse(completedAnswer));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('Q');

    await screen.findByText('Not enough evidence.');

    // act's async exit crosses a macrotask boundary, which drains the released response's whole
    // promise chain — no timer, so no wall-clock race.
    await act(async () => {
      stale.release();
      await stale.response;
    });

    expect(screen.getByText('Not enough evidence.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders an answered outcome via the provenance rail, with a fully verified verification panel', async () => {
    const completedAnswer = {
      id: 'answer-5',
      questionText: 'What is the cap rate?',
      runStatus: 'completed',
      outcome: {
        kind: 'answered',
        claims: [
          {
            statement: 'The cap rate is 6.1%.',
            citations: [
              {
                docVersionId: 'docver-1',
                sha256: 'a'.repeat(64),
                chunkId: 'chunk-a',
                locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
                quote: 'Cap rate: 6.1%',
              },
            ],
          },
        ],
      },
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
      verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
    };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'answer-5', runStatus: 'queued' }, 201));
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(completedAnswer)));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('What is the cap rate?');

    await screen.findByText('The cap rate is 6.1%.');

    expect(screen.getByText('Cap rate: 6.1%')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 claim verified against the source')).toBeInTheDocument();
    expect(screen.queryByText(/not asserted/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/was checked against the source and verified/),
    ).not.toBeInTheDocument();
  });

  it('renders the verification panel disclosure for a dropped claim', async () => {
    const completedAnswer = {
      id: 'answer-6',
      questionText: 'What is the occupancy rate?',
      runStatus: 'completed',
      outcome: { kind: 'insufficient_evidence', reason: 'No document mentions occupancy.' },
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
      verificationReport: {
        verifiedClaimCount: 1,
        totalClaimCount: 2,
        droppedClaims: [
          { statement: 'Occupancy is 95%.', reason: 'No retrieved chunk supports this figure.' },
        ],
      },
    };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'answer-6', runStatus: 'queued' }, 201));
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(completedAnswer)));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('What is the occupancy rate?');

    await screen.findByText('1 of 2 claims verified against the source');

    expect(
      screen.getByText(
        'No claim could be verified against the source — this is why the model abstained.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('No retrieved chunk supports this figure.')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Show statement'));

    expect(screen.getByText('Occupancy is 95%.')).toBeInTheDocument();
  });

  it('replaces polling with SSE, applying a named answer event and closing the source on a terminal one', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);

    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/questions') {
        return Promise.resolve(jsonResponse({ id: 'answer-7', runStatus: 'queued' }, 201));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('Q');

    await screen.findByText('queued');

    const [source] = FakeEventSource.instances;
    expect(source.url).toBe('/api/v1/answers/answer-7/events');

    act(() => {
      source.emit('heartbeat', {});
    });
    expect(source.closed).toBe(false);

    act(() => {
      source.emit('answer', {
        id: 'answer-7',
        questionText: 'Q',
        runStatus: 'completed',
        outcome: { kind: 'insufficient_evidence', reason: 'No evidence found.' },
        citations: [],
        conflictIds: [],
        createdAt: new Date().toISOString(),
      });
    });

    await screen.findByText('No evidence found.');

    // The terminal event closes the source itself; a poll must never have been issued either.
    expect(source.closed).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/answers/answer-7')).toBe(false);
  });

  it('guards against a double submit between the click and the button becoming disabled', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(jsonResponse({ id: 'answer-8', runStatus: 'queued' }, 201)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Q' } });
    const button = screen.getByRole('button', { name: 'Ask' });
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByText('queued');

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/v1/questions')).toHaveLength(1);
  });
});
