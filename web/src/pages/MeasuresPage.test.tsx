import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import MeasuresPage from './MeasuresPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <MeasuresPage />
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(routes: Record<string, () => Response>): void {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
}

const populatedMeasures = {
  answersCompleted: 42,
  answersWithVerifiedCitations: 30,
  conflictsSurfaced: 5,
  conflictsResolved: 3,
  meanEvidenceDocumentsPerAnswer: 2.5,
  medianAnswerLatencyMs: 1200,
  p95AnswerLatencyMs: 4800,
};

const emptyMeasures = {
  answersCompleted: 0,
  answersWithVerifiedCitations: 0,
  conflictsSurfaced: 0,
  conflictsResolved: 0,
  meanEvidenceDocumentsPerAnswer: null,
  medianAnswerLatencyMs: null,
  p95AnswerLatencyMs: null,
};

describe('MeasuresPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('renders the populated figures, formatting the mean to one decimal and latency in ms', async () => {
    stubFetch({
      '/api/v1/measures': () => jsonResponse(populatedMeasures),
    });

    renderPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Pilot measures' });
    expect(within(table).getByText('42')).toBeInTheDocument();
    expect(within(table).getByText('30')).toBeInTheDocument();
    expect(within(table).getByText('5')).toBeInTheDocument();
    expect(within(table).getByText('3')).toBeInTheDocument();
    expect(within(table).getByText('2.5')).toBeInTheDocument();
    expect(within(table).getByText('1200 ms')).toBeInTheDocument();
    expect(within(table).getByText('4800 ms')).toBeInTheDocument();
  });

  it('renders explanatory text, never 0 or a dash, when a figure has nothing measurable yet', async () => {
    stubFetch({
      '/api/v1/measures': () => jsonResponse(emptyMeasures),
    });

    renderPage();

    const table = await screen.findByRole('table', { name: 'Pilot measures' });
    const noAnswersYetCells = within(table).getAllByText('No answers yet');
    expect(noAnswersYetCells).toHaveLength(3);
    expect(within(table).queryByText('0 ms')).not.toBeInTheDocument();
    expect(within(table).queryByText('—')).not.toBeInTheDocument();
  });

  it('shows an error when measures fail to load', async () => {
    stubFetch({
      '/api/v1/measures': () => jsonResponse({ message: 'Measures unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Measures unavailable');
  });
});
