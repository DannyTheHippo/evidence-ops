import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AskPage from './AskPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
    fetchMock.mockResolvedValue(jsonResponse(completedAnswer));
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

  it('renders a conflict badge on a conflicting_evidence answer with side-by-side values', async () => {
    const completedAnswer = {
      id: 'answer-2',
      questionText: 'What is the cap rate?',
      runStatus: 'completed',
      outcome: {
        kind: 'conflicting_evidence',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-a' },
          { value: 6.4, unit: 'percent', sourceChunkId: 'chunk-b' },
        ],
      },
      citations: [],
      conflictIds: ['conflict-1'],
      createdAt: new Date().toISOString(),
    };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'answer-2', runStatus: 'queued' }, 201));
    fetchMock.mockResolvedValue(jsonResponse(completedAnswer));
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
    expect(screen.getByText('source: chunk-a')).toBeInTheDocument();
    expect(screen.getByText('source: chunk-b')).toBeInTheDocument();
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
    // Never a legitimate response — if polling kept running after completion, this is what the
    // next call would return, and the test below would see it flip the UI.
    const poisonedAnswer = { ...runningAnswer, runStatus: 'failed', outcome: undefined };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'answer-3', runStatus: 'queued' }, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(runningAnswer));
    fetchMock.mockResolvedValueOnce(jsonResponse(completedAnswer));
    fetchMock.mockResolvedValue(jsonResponse(poisonedAnswer));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <AskPage pollIntervalMs={5} />
      </MemoryRouter>,
    );

    ask('Q');

    await screen.findByText('Not enough evidence.');

    // Give the poisoned response several intervals worth of real time to land, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(screen.getByText('Not enough evidence.')).toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
