import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer, Verification } from '../api/client';
import { FakeEventSource } from '../test/fake-event-source';
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
  atoms: [],
  withdrawnCitedDocVersionIds: [],
  answerPath: 'synthesis',
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
  atoms: [],
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
  atoms: [],
  withdrawnCitedDocVersionIds: [],
};

const running: Answer = {
  id: 'answer-4',
  questionText: 'What is the debt service coverage ratio for Eastgate Tower?',
  runStatus: 'running',
  citations: [],
  conflictIds: [],
  createdAt: '2026-08-04T12:00:00.000Z',
  atoms: [],
  withdrawnCitedDocVersionIds: [],
};

const verification: Verification = {
  id: 'verification-1',
  requestedBy: { kind: 'pat', id: 'pat-1' },
  claims: ['The cap rate is 6.2%', 'Occupancy is 92%'],
  results: [
    { claimIndex: 0, verdict: 'grounded' },
    { claimIndex: 1, verdict: 'not_grounded' },
  ],
  advisory: 'A verdict is not a legal or financial opinion.',
  retrievedChunkIds: [],
  atoms: [],
  usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
  createdAt: '2026-08-05T12:00:00.000Z',
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

    // The Kind column marks every row an answer, and the Path column reads the server's
    // answerPath verbatim when present, falling back to a placeholder when it is not.
    expect(within(answeredRow).getByText('answer')).toBeInTheDocument();
    expect(within(answeredRow).getByText('synthesis')).toBeInTheDocument();
    expect(insufficientRow.querySelector('[data-label="Path"]')).toHaveTextContent('—');

    expect(
      screen.getByRole('table', { name: 'Answers and verifications with their grounding' }),
    ).toBeInTheDocument();

    expect(screen.getByRole('region', { name: 'Answers and verifications' })).toHaveAttribute(
      'tabindex',
      '0',
    );

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
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
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

  it('shows the no-answers-yet empty state with no action button when there is no filter', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No answers yet')).toBeInTheDocument();
    expect(screen.getByText('Ask a question above to see it appear here.')).toBeInTheDocument();
    // The composer lives on this page now, so the empty state carries no `Ask a question` link.
    expect(screen.queryByRole('link', { name: 'Ask a question' })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Coverage' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/answers?skip=0&limit=25&sort=claimCoverage&sortDir=desc',
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Coverage, sorted descending' }));
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

  it('renders the composer above the history', () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(screen.getByLabelText('Question')).toBeInTheDocument();
  });

  it('prefills the composer from ?q= and strips it from the address bar', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage(['/answers?q=What%20is%20the%20cap%20rate%3F']);

    expect(screen.getByLabelText('Question')).toHaveValue('What is the cap rate?');
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement(),
    );
  });

  it('seeds a run from the composer in place, and refetches the history once it starts', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      if (url === '/api/v1/questions' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'answer-9', runStatus: 'queued' }, 201));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No answers yet');

    fireEvent.change(screen.getByLabelText('Question'), {
      target: { value: 'What is the cap rate?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    // The seeded run renders in place, directly below the composer — never a navigation to
    // `/answers/:id`.
    expect(await screen.findByText('queued')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();

    await waitFor(() => {
      const answerRequests = fetchMock.mock.calls.filter(
        ([url]) => url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc',
      );
      expect(answerRequests.length).toBeGreaterThan(1);
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === '/api/v1/questions' && init?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('switches to the verifications kind, resetting paging and sort, and renders the tally, badge and detail link', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 30 }));
      }
      if (url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(
          jsonResponse({ docs: [{ ...answered, id: 'answer-page-2' }], count: 30 }),
        );
      }
      if (url === '/api/v1/verifications?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [verification], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('26–30 of 30');

    fireEvent.click(screen.getByRole('button', { name: 'Verifications' }));

    expect(await screen.findByText('1 grounded · 1 not grounded')).toBeInTheDocument();
    const row = screen.getByText('1 grounded · 1 not grounded').closest('tr');
    if (!row) throw new Error('row not found');
    expect(within(row).getByText('verification')).toBeInTheDocument();
    expect(within(row).getByRole('link')).toHaveAttribute(
      'href',
      '/answers/verifications/verification-1',
    );

    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/verifications?skip=0&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);

    // Paging (`skip=25`) reset along with the switch — only the non-default `kind` remains.
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      '?kind=verifications',
    );
  });
});
