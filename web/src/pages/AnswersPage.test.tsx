import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

// Exposes the current query string as accessible text, since `MemoryRouter` gives a test no other
// way to read it — proves the URL round-trip without reaching into router internals.
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current search">{location.search}</output>;
}

function renderPage(initialEntries: string[] = ['/answers']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <AnswersPage />
      <LocationProbe />
    </MemoryRouter>,
  );
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
  withdrawnCitedDocVersionIds: [],
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
  withdrawnCitedDocVersionIds: [],
};

const insufficient: Answer = {
  id: 'answer-3',
  questionText: 'What is the projected NOI for a property with no filings?',
  runStatus: 'completed',
  outcome: { kind: 'insufficient_evidence', reason: 'No relevant evidence was retrieved.' },
  citations: [],
  conflictIds: [],
  createdAt: '2026-08-03T12:00:00.000Z',
  withdrawnCitedDocVersionIds: [],
};

const running: Answer = {
  id: 'answer-4',
  questionText: 'What is the debt service coverage ratio for Eastgate Tower?',
  runStatus: 'running',
  citations: [],
  conflictIds: [],
  createdAt: '2026-08-04T12:00:00.000Z',
  withdrawnCitedDocVersionIds: [],
};

describe('AnswersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists answers with the outcome badge for each completed outcome kind', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered, conflicting, insufficient], count: 3 }),
    });

    renderPage();

    expect(screen.getByText('Loading answers…')).toBeInTheDocument();
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

    expect(
      screen.getByRole('region', { name: 'Answered questions and their grounding' }),
    ).toHaveAttribute('tabindex', '0');

    expect(screen.getByRole('link', { name: answered.questionText })).toHaveAttribute(
      'href',
      '/answers/answer-1',
    );

    // A trailing result count in the toolbar's end slot, plural for more than one answer.
    expect(screen.getByText('3 answers')).toBeInTheDocument();
  });

  it('states the result count in the singular for exactly one answer', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered], count: 1 }),
    });

    renderPage();

    await screen.findByText(answered.questionText);
    expect(screen.getByText('1 answer')).toBeInTheDocument();
  });

  it('renders the claim-coverage meter as decorative, with the percentage text carrying the value', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText(answered.questionText)).closest('tr');
    if (!row) throw new Error('row not found');
    const meter = row.querySelector('.coverage-meter');
    expect(meter).toHaveAttribute('aria-hidden', 'true');
    // 0.875 rounds to the 9th decile of ten, not the 8th the raw percentage would suggest.
    expect(meter).toHaveClass('coverage-meter--9');
    expect(within(row).getByText('88%')).toBeInTheDocument();
  });

  it('shows the run status, not an outcome, for an answer that has not completed', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [running], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText(running.questionText)).closest('tr');
    if (!row) throw new Error('row not found');
    expect(within(row).getByText('running')).toBeInTheDocument();
  });

  it('renders a placeholder, not 0%, when claimCoverage is absent', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [insufficient], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText(insufficient.questionText)).closest('tr');
    if (!row) throw new Error('row not found');
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText('0%')).not.toBeInTheDocument();
  });

  it('renders the claimCoverage fraction as a percentage when present', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText(answered.questionText)).closest('tr');
    if (!row) throw new Error('row not found');
    expect(within(row).getByText('88%')).toBeInTheDocument();
  });

  it('shows a caution badge when an answer cites a withdrawn document version, and no badge otherwise', async () => {
    const withdrawn: Answer = {
      ...answered,
      id: 'answer-5',
      questionText: 'What is the debt yield for Northgate Business Park?',
      withdrawnCitedDocVersionIds: ['docver-1'],
    };
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [withdrawn, answered], count: 2 }),
    });

    renderPage();

    const withdrawnRow = (await screen.findByText(withdrawn.questionText)).closest('tr');
    const otherRow = screen.getByText(answered.questionText).closest('tr');
    if (!withdrawnRow || !otherRow) throw new Error('row not found');

    expect(within(withdrawnRow).getByText('citation withdrawn')).toBeInTheDocument();
    expect(within(otherRow).queryByText('citation withdrawn')).not.toBeInTheDocument();
  });

  it('shows the no-answers-yet empty state with a link to Ask when there is no filter', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No answers yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask a question' })).toHaveAttribute('href', '/ask');
  });

  it('shows a filter-specific empty state when a run status filter matches nothing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url === '/api/v1/answers?skip=0&limit=25&runStatus=failed&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('No answers match this filter')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ask a question' })).not.toBeInTheDocument();
  });

  it('applies the run status filter as a query parameter, not client-side', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url === '/api/v1/answers?skip=0&limit=25&runStatus=failed&sort=createdAt&sortDir=desc') {
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
        ([url]) =>
          url === '/api/v1/answers?skip=0&limit=25&runStatus=failed&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
  });

  it('resets paging to the first page in the same patch as applying a filter, and keeps the URL clean at defaults', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 30 }));
      }
      if (url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(
          jsonResponse({ docs: [{ ...answered, id: 'answer-page-2' }], count: 30 }),
        );
      }
      if (url === '/api/v1/answers?skip=0&limit=25&runStatus=failed&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    // A page at its defaults keeps a clean address bar.
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('26–30 of 30');

    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await screen.findByText('1–1 of 1');

    // The filter landed and paging reset to the first page in the same patch — the URL carries
    // only the non-default `runStatus`, never a leftover `skip`.
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      '?runStatus=failed',
    );
  });

  it('reproduces a filtered, sorted, paged view from a deep link', async () => {
    stubFetch({
      '/api/v1/answers?skip=25&limit=25&runStatus=failed&sort=claimCoverage&sortDir=asc': () =>
        jsonResponse({ docs: [answered], count: 30 }),
    });

    renderPage(['/answers?runStatus=failed&sort=claimCoverage&sortDir=asc&skip=25']);

    await screen.findByText(answered.questionText);
    expect(screen.getByLabelText('Run status')).toHaveValue('failed');
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('sorts by a column on click, defaulting to descending and toggling on the active column', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc' ||
        url === '/api/v1/answers?skip=0&limit=25&sort=claimCoverage&sortDir=desc' ||
        url === '/api/v1/answers?skip=0&limit=25&sort=claimCoverage&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Claim coverage' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/answers?skip=0&limit=25&sort=claimCoverage&sortDir=desc',
        ),
      ).toBe(true);
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Sort by Claim coverage, sorted descending' }),
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/answers?skip=0&limit=25&sort=claimCoverage&sortDir=asc',
        ),
      ).toBe(true);
    });
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 30 }));
      }
      if (url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(
          jsonResponse({ docs: [{ ...answered, id: 'answer-page-2' }], count: 30 }),
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

    await screen.findByText('26–30 of 30');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('shows an error when answers fail to load', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ message: 'Answers unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Answers unavailable');
  });
});
