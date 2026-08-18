import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '../api/client';
import AnswersPage from './AnswersPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL, matching AuditEventsPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, () => Response>): void {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
}

const answered: Answer = {
  id: 'answer-1',
  questionText: 'What is the cap rate for Northgate Business Park?',
  runStatus: 'completed',
  outcome: {
    kind: 'answered',
    claims: [],
  },
  claimCoverage: 0.875,
  citations: [],
  conflictIds: [],
  createdAt: '2026-08-01T12:00:00.000Z',
};

const conflicting: Answer = {
  id: 'answer-2',
  questionText: 'What is the vacancy rate reported for Southgate Plaza?',
  runStatus: 'completed',
  outcome: {
    kind: 'conflicting_evidence',
    factKey: { entity: 'Southgate Plaza', metric: 'vacancy_rate', period: '2025-Q1' },
    values: [],
  },
  citations: [],
  conflictIds: ['conflict-1'],
  createdAt: '2026-08-02T12:00:00.000Z',
};

const insufficient: Answer = {
  id: 'answer-3',
  questionText: 'What is the projected NOI for a property with no filings?',
  runStatus: 'completed',
  outcome: { kind: 'insufficient_evidence', reason: 'No relevant evidence was retrieved.' },
  citations: [],
  conflictIds: [],
  createdAt: '2026-08-03T12:00:00.000Z',
};

const running: Answer = {
  id: 'answer-4',
  questionText: 'What is the debt service coverage ratio for Eastgate Tower?',
  runStatus: 'running',
  citations: [],
  conflictIds: [],
  createdAt: '2026-08-04T12:00:00.000Z',
};

function renderPage() {
  render(
    <MemoryRouter>
      <AnswersPage />
    </MemoryRouter>,
  );
}

describe('AnswersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists answers with the outcome badge for each completed outcome kind', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25': () =>
        jsonResponse({ docs: [answered, conflicting, insufficient], count: 3 }),
    });

    renderPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText(answered.questionText)).toBeInTheDocument();

    const answeredRow = screen.getByText(answered.questionText).closest('tr');
    const conflictingRow = screen.getByText(conflicting.questionText).closest('tr');
    const insufficientRow = screen.getByText(insufficient.questionText).closest('tr');
    if (!answeredRow || !conflictingRow || !insufficientRow) throw new Error('row not found');

    expect(within(answeredRow).getByText('answered')).toBeInTheDocument();
    expect(within(conflictingRow).getByText('conflicting evidence')).toBeInTheDocument();
    expect(within(insufficientRow).getByText('insufficient evidence')).toBeInTheDocument();

    expect(
      screen.getByRole('table', { name: 'Answered questions and their grounding' }),
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: answered.questionText })).toHaveAttribute(
      'href',
      '/answers/answer-1',
    );
  });

  it('shows the run status, not an outcome, for an answer that has not completed', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25': () => jsonResponse({ docs: [running], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText(running.questionText)).closest('tr');
    if (!row) throw new Error('row not found');
    expect(within(row).getByText('running')).toBeInTheDocument();
  });

  it('renders a placeholder, not 0%, when claimCoverage is absent', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25': () => jsonResponse({ docs: [insufficient], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText(insufficient.questionText)).closest('tr');
    if (!row) throw new Error('row not found');
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText('0%')).not.toBeInTheDocument();
  });

  it('renders the claimCoverage fraction as a percentage when present', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25': () => jsonResponse({ docs: [answered], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText(answered.questionText)).closest('tr');
    if (!row) throw new Error('row not found');
    expect(within(row).getByText('88%')).toBeInTheDocument();
  });

  it('shows the no-answers-yet empty state with a link to Ask when there is no filter', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No answers yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask a question' })).toHaveAttribute('href', '/ask');
  });

  it('shows a filter-specific empty state when a run status filter matches nothing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url === '/api/v1/answers?skip=0&limit=25&runStatus=failed') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('No answers match this filter.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ask a question' })).not.toBeInTheDocument();
  });

  it('applies the run status filter as a query parameter, not client-side', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url === '/api/v1/answers?skip=0&limit=25&runStatus=failed') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await screen.findByText(answered.questionText);

    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/answers?skip=0&limit=25&runStatus=failed',
      ),
    ).toBe(true);
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 30 }));
      }
      if (url === '/api/v1/answers?skip=25&limit=25') {
        return Promise.resolve(
          jsonResponse({ docs: [{ ...answered, id: 'answer-5' }], count: 30 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('30 total');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/answers?skip=25&limit=25')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('shows an error when answers fail to load', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25': () =>
        jsonResponse({ message: 'Answers unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Answers unavailable');
  });
});
