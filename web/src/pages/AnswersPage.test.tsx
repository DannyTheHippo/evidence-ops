import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer, Verification } from '../api/client';
import { clearAnnouncements, subscribeAnnouncements } from '../lib/announce';
import { FakeEventSource } from '../test/fake-event-source';
import AnswersPage from './AnswersPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Resolves on demand, so a test can control which of two concurrent fetches settles first —
// mirrors RunsPage.test.tsx's own helper for the same race.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAnnouncements();
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

    // The Answer path column reads the server's answerPath verbatim when present, falling back to
    // a placeholder when it is not. No Kind column: the segmented control above already states
    // which kind every row on screen belongs to.
    expect(within(answeredRow).getByText('synthesis')).toBeInTheDocument();
    expect(insufficientRow.querySelector('[data-label="Answer path"]')).toHaveTextContent('—');
    expect(screen.queryByRole('columnheader', { name: 'Kind' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Answer path' })).toBeInTheDocument();

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

    const title = await screen.findByText('No answers yet');
    expect(title).toBeInTheDocument();
    // The earned-zero-inbox treatment distinguishes "nothing has ever answered" from a filter that
    // simply matches nothing.
    expect(title.closest('.empty-state--zero')).not.toBeNull();
    expect(screen.getByText('Ask a question above to see it appear here.')).toBeInTheDocument();
    // The composer lives on this page now, so the empty state carries no `Ask a question` link.
    expect(screen.queryByRole('link', { name: 'Ask a question' })).not.toBeInTheDocument();
  });

  it('shows a filter-specific empty state with a Show-all action when a run status filter matches nothing', async () => {
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

    const title = await screen.findByText('No answers match this filter');
    expect(title).toBeInTheDocument();
    expect(title.closest('.empty-state--zero')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ask a question' })).not.toBeInTheDocument();

    const showAll = screen.getByRole('button', { name: 'Show all answers' });
    fireEvent.click(showAll);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });
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

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url === '/api/v1/answers?skip=0&limit=25&runStatus=failed&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });
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
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
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

    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('26–30 of 30');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
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
    // The fourth column names the caller for this kind, not an answer's route.
    expect(screen.getByRole('columnheader', { name: 'Requested by' })).toBeInTheDocument();
    expect(row.querySelector('[data-label="Requested by"]')).toHaveTextContent('pat');
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

  it('drops the run status and date filters on a kind switch, in the URL and in the controls', async () => {
    const failed: Answer = {
      ...running,
      id: 'answer-6',
      questionText: 'What is the exit cap for Westgate Retail?',
      runStatus: 'failed',
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url.startsWith('/api/v1/answers?') && url.includes('runStatus=failed')) {
        return Promise.resolve(jsonResponse({ docs: [failed], count: 1 }));
      }
      if (url === '/api/v1/verifications?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [verification], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: '7d' },
    });

    await screen.findByText(failed.questionText);
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      '?runStatus=failed&range=7d',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Verifications' }));
    await screen.findByText('1 grounded · 1 not grounded');

    // The verifications list has no run-status column and takes no run-status param, so the
    // filter cannot survive the switch — in the URL or in the select it is restored from. Anchored,
    // since a leaked `runStatus` would sit beside `kind` and still contain it as a substring.
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      /^\?kind=verifications$/,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Answers' }));

    expect(await screen.findByText(answered.questionText)).toBeInTheDocument();
    expect(screen.getByLabelText('Run status')).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Created' })).toHaveValue('');
  });

  it('drops a slow answers response that lands after a newer one', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return first.promise;
      }
      if (url === '/api/v1/answers?skip=0&limit=25&runStatus=failed&sort=createdAt&sortDir=desc') {
        return second.promise;
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    expect(screen.getByText('Loading answers…')).toBeInTheDocument();

    // Changing a filter starts a second, newer fetch while the first is still in flight.
    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'failed' } });

    // The newer request settles first.
    second.resolve(jsonResponse({ docs: [conflicting], count: 1 }));
    await screen.findByText(conflicting.questionText);

    // The superseded, older request settles after and must not overwrite the newer rows.
    first.resolve(jsonResponse({ docs: [answered], count: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText(conflicting.questionText)).toBeInTheDocument();
    expect(screen.queryByText(answered.questionText)).not.toBeInTheDocument();
  });

  it('never shows the verifications total on the answers pager', async () => {
    const answersDeferred = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return answersDeferred.promise;
      }
      if (url === '/api/v1/verifications?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [verification], count: 7 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    expect(screen.getByText('Loading answers…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Verifications' }));
    await screen.findByText('7 verifications');

    // The stale answers response — for a kind the operator has since left — settles after the
    // switch and must never surface as the verifications total.
    answersDeferred.resolve(jsonResponse({ docs: [answered], count: 43 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('7 verifications')).toBeInTheDocument();
    expect(screen.queryByText(/43/)).not.toBeInTheDocument();
  });

  it('keeps the pager mounted across a page turn', async () => {
    const pageTwo = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 30 }));
      }
      if (url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return pageTwo.promise;
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // The second page's fetch is still in flight; nulling `items` on a page turn would unmount
    // the pager and the first page's row rather than leaving both in place until the fresh page
    // lands.
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(screen.getByText(answered.questionText)).toBeInTheDocument();

    pageTwo.resolve(jsonResponse({ docs: [{ ...answered, id: 'answer-page-2' }], count: 30 }));
    await screen.findByText('26–30 of 30');
  });

  it('refreshes the history once the composer run settles', async () => {
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

    await screen.findByText('queued');

    const stream = FakeEventSource.instances.at(-1);
    if (!stream) throw new Error('no event source opened');
    stream.emit('answer', {
      id: 'answer-9',
      questionText: 'What is the cap rate?',
      runStatus: 'completed',
      outcome: { kind: 'insufficient_evidence', reason: 'No relevant evidence was retrieved.' },
      citations: [],
      conflictIds: [],
      createdAt: new Date().toISOString(),
      atoms: [],
      withdrawnCitedDocVersionIds: [],
    });

    // Two fetches follow the initial load: one for the run starting, one for it settling.
    await waitFor(() => {
      const answerRequests = fetchMock.mock.calls.filter(
        ([url]) => url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc',
      );
      expect(answerRequests.length).toBeGreaterThan(2);
    });
  });

  it('sends the selected custom date range as from and to', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url.includes('from=') || url.includes('to=')) {
        return Promise.resolve(jsonResponse({ docs: [conflicting], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);
    const callsBeforeCustom = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });

    // An empty custom range filters nothing: it reveals the dates without a request or a Clear.
    expect(screen.getByLabelText('From')).toHaveValue('');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.length).toBe(callsBeforeCustom);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-05' } });

    await screen.findByText(conflicting.questionText);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url.includes('to='))).toBe(true);
    });

    const call = fetchMock.mock.calls.filter(([url]) => url.includes('from=')).at(-1);
    const requestUrl = new URL(call![0], 'http://localhost');
    // Bounds are the operator's *local* midnight (`toDateRangeInstants`), not UTC — a hardcoded
    // `...T00:00:00.000Z` string would only match a UTC host and pass by accident there. Asserting
    // local date/time components instead catches a regression back to UTC arithmetic on any host.
    const fromDate = new Date(requestUrl.searchParams.get('from')!);
    expect([fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()]).toEqual([2026, 7, 1]);
    expect([fromDate.getHours(), fromDate.getMinutes()]).toEqual([0, 0]);

    // The range folds into the applied filter, so it is clearable and survives a reload.
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      /^\?range=custom&from=2026-08-01&to=2026-08-05$/,
    );
  });

  it('applies the Last 7 days preset as whole local days including today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 10, 30));
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url.includes('from=')) {
        return Promise.resolve(jsonResponse({ docs: [conflicting], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: '7d' },
    });

    await screen.findByText(conflicting.questionText);
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      /^\?range=7d$/,
    );

    const call = fetchMock.mock.calls.find(([url]) => url.includes('from='));
    const requestUrl = new URL(call![0], 'http://localhost');
    const fromDate = new Date(requestUrl.searchParams.get('from')!);
    expect([fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()]).toEqual([2026, 8, 8]);
    expect([fromDate.getHours(), fromDate.getMinutes()]).toEqual([0, 0]);
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('reads a from-only deep link as a custom range with From filled', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/answers?') && url.includes('from=')) {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/answers?from=2026-09-01']);

    await screen.findByText(answered.questionText);
    expect(screen.getByRole('combobox', { name: 'Created' })).toHaveValue('custom');
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveValue('');
  });

  it('renders the list without an error for an unparseable from in the URL, sending no from', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/answers?from=garbage']);

    await screen.findByText(answered.questionText);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Created' })).toHaveValue('');
    expect(fetchMock.mock.calls.some(([url]) => url.includes('from='))).toBe(false);
  });

  it('announces the result count once per filter change, and nothing on the first load', async () => {
    const messages: string[] = [];
    subscribeAnnouncements((message) => messages.push(message));
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered, conflicting], count: 2 }),
      '/api/v1/answers?skip=0&limit=25&runStatus=failed&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [conflicting], count: 1 }),
    });

    renderPage();
    await screen.findByText(answered.questionText);
    expect(messages).toEqual([]);

    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'failed' } });

    await waitFor(() => {
      expect(messages).toEqual(['1 answer']);
    });
    expect(screen.queryByText(answered.questionText)).not.toBeInTheDocument();
  });

  it('includes the chosen end day in the range', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url.includes('from=') || url.includes('to=')) {
        return Promise.resolve(jsonResponse({ docs: [conflicting], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-05' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-05' } });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url.includes('to='))).toBe(true);
    });
    await screen.findByText(conflicting.questionText);

    const call = fetchMock.mock.calls.filter(([url]) => url.includes('to=')).at(-1);
    const requestUrl = new URL(call![0], 'http://localhost');
    // `to` is exclusive on the wire, so a single-day range is sent as local midnight the day
    // after — an answer created during the chosen day still falls inside it.
    const toDate = new Date(requestUrl.searchParams.get('to')!);
    expect([toDate.getFullYear(), toDate.getMonth(), toDate.getDate()]).toEqual([2026, 7, 6]);
    expect([toDate.getHours(), toDate.getMinutes()]).toEqual([0, 0]);
  });

  it('carries the chosen page size into the request', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(
          jsonResponse({ docs: [{ ...answered, id: 'answer-page-2' }], count: 60 }),
        );
      }
      if (url === '/api/v1/answers?skip=0&limit=50&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [conflicting], count: 60 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/answers?skip=25']);
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });

    // The new size resets paging: page 2 of twenty-five-row pages is not page 2 of fifty-row pages.
    await screen.findByText(conflicting.questionText);
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/answers?skip=0&limit=50&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
  });

  it('reveals an empty Custom range on page 2 without refetching, resetting skip, or announcing', async () => {
    const messages: string[] = [];
    subscribeAnnouncements((message) => messages.push(message));
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 30 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/answers?skip=25']);
    await screen.findByText(answered.questionText);
    const callsBeforeCustom = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.length).toBe(callsBeforeCustom);
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(/skip=25/);
    expect(messages).toEqual([]);
  });

  it('blocks a From after To from reaching the API and keeps the last valid results', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [answered], count: 1 }));
      }
      if (url.includes('from=') && !url.includes('to=')) {
        return Promise.resolve(jsonResponse({ docs: [conflicting], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText(answered.questionText);

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-20' } });
    await screen.findByText(conflicting.questionText);
    const callsBeforeInvertedTo = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-10' } });

    const toField = screen.getByLabelText('To');
    expect(toField).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('From must be on or before To.')).toBeInTheDocument();
    // No further request — not one carrying the inverted pair, not any other — and the results
    // from the last valid (from-only) query stay on screen.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeInvertedTo);
    expect(screen.getByText(conflicting.questionText)).toBeInTheDocument();
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered], count: 1 }),
    });

    renderPage(['/answers?sort=bogus&sortDir=up']);

    await screen.findByText(answered.questionText);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('falls back to the default page size for an out-of-range one in the URL, and clamps a negative skip', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered], count: 1 }),
    });

    renderPage(['/answers?limit=5000&skip=-1']);

    await screen.findByText(answered.questionText);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Rows per page')).toHaveValue('25');
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('no longer exposes the question only through a title attribute', async () => {
    stubFetch({
      '/api/v1/answers?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [answered], count: 1 }),
    });

    renderPage();

    const subject = await screen.findByText(answered.questionText);
    expect(subject).toHaveClass('cell-truncate');
    expect(subject).not.toHaveAttribute('title');

    // The colgroup is what lets the Subject column's `.cell-truncate` actually clip: a fixed
    // `table-layout` needs every other column's width stated up front, so the leading `<col>`
    // (Subject) is the only one carrying no width class.
    const cols = screen.getByRole('table').querySelectorAll('col');
    expect(cols).toHaveLength(5);
    expect(cols[0]).not.toHaveAttribute('class');
    expect(screen.getByRole('table')).toHaveClass('answers-grid');

    // The Tooltip wraps the RowLink, so keyboard focus on the link opens it and the link itself
    // carries the description.
    const link = screen.getByRole('link', { name: answered.questionText });
    expect(link).toHaveAttribute('href', '/answers/answer-1');

    link.focus();
    const surface = await screen.findByRole('tooltip');
    expect(surface).toHaveTextContent(answered.questionText);
    expect(link).toHaveAttribute('aria-describedby', surface.id);
  });
});
