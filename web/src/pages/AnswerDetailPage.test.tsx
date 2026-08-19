import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnswerDetailPage from './AnswerDetailPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

function renderAt(id: string) {
  render(
    <MemoryRouter initialEntries={[`/answers/${id}`]}>
      <Routes>
        <Route path="/answers/:id" element={<AnswerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AnswerDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
});
