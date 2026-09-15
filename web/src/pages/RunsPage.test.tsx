import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAnnouncements, subscribeAnnouncements } from '../lib/announce';
import RunsPage from './RunsPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Resolves on demand, so a test can control which of two concurrent fetches settles first —
// mirrors use-latest.test.tsx's own helper for the same race.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const completedRun = {
  id: 'run-1',
  workflowId: 'wf-1',
  workflowType: 'sync-source' as const,
  status: 'completed' as const,
  createdAt: '2026-08-01T12:00:00.000Z',
};

const failedRun = {
  id: 'run-2',
  workflowId: 'wf-2',
  workflowType: 'resolve-conflict' as const,
  status: 'failed' as const,
  errorMessage: 'Model timeout',
  createdAt: '2026-08-02T09:30:00.000Z',
};

// Written before the API recorded a type; the row must still render under a generic label rather
// than a blank cell.
const untypedRun = {
  id: 'run-3',
  workflowId: 'wf-3',
  status: 'queued' as const,
  createdAt: '2026-08-03T08:00:00.000Z',
};

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

function renderPage(initialEntries: string[] = ['/workflow-runs']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <RunsPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('RunsPage', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAnnouncements();
  });

  it('names each run by workflow type, keeping the opaque id as secondary detail', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun, failedRun, untypedRun], count: 3 }),
    });

    renderPage();

    expect(screen.getByText('Loading workflow runs…')).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Workflow runs, most recent first' });
    expect(table).toBeInTheDocument();

    // The link text is the human label, not the uuid — that is the whole point of the column.
    const completedLink = screen.getByRole('link', { name: 'Source sync' });
    expect(completedLink).toHaveAttribute('href', '/workflow-runs/run-1');
    expect(within(table).getByText('Completed')).toBeInTheDocument();

    const failedLink = screen.getByRole('link', { name: 'Conflict resolution' });
    expect(failedLink).toHaveAttribute('href', '/workflow-runs/run-2');
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    // The truncated reason is its own keyboard stop, and focus on it opens the full-text tooltip.
    const reason = screen.getByText('Model timeout');
    expect(reason).toHaveAttribute('tabindex', '0');
    reason.focus();
    const reasonTooltip = await screen.findByRole('tooltip');
    expect(reasonTooltip).toHaveTextContent('Model timeout');
    expect(reason).toHaveAttribute('aria-describedby', reasonTooltip.id);
    reason.blur();

    expect(
      screen.getByRole('region', { name: 'Workflow runs, most recent first' }),
    ).toHaveAttribute('tabindex', '0');

    expect(screen.getByRole('link', { name: 'Workflow run' })).toHaveAttribute(
      'href',
      '/workflow-runs/run-3',
    );

    // The id stays on screen, shortened, with the full value recoverable through the Tooltip,
    // which keyboard focus on the id also opens.
    expect(screen.getByText('wf-1')).toHaveAttribute('tabindex', '0');
  });

  it('renders the outcome beside the status, and a not-recorded reason for a failed run with none', async () => {
    const resolvedRun = {
      id: 'run-4',
      workflowId: 'wf-4',
      workflowType: 'resolve-conflict' as const,
      status: 'completed' as const,
      outcome: 'resolved' as const,
      createdAt: '2026-08-04T10:00:00.000Z',
    };
    const timedOutRun = {
      id: 'run-5',
      workflowId: 'wf-5',
      workflowType: 'resolve-conflict' as const,
      status: 'completed' as const,
      outcome: 'timed_out' as const,
      createdAt: '2026-08-05T10:00:00.000Z',
    };
    const failedNoMessageRun = {
      id: 'run-6',
      workflowId: 'wf-6',
      workflowType: 'sync-source' as const,
      status: 'failed' as const,
      createdAt: '2026-08-06T10:00:00.000Z',
    };
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [resolvedRun, timedOutRun, failedNoMessageRun], count: 3 }),
    });

    renderPage();

    const table = await screen.findByRole('table', { name: 'Workflow runs, most recent first' });
    await within(table).findAllByText('Completed');
    expect(within(table).getByText('Resolved')).toBeInTheDocument();
    expect(within(table).getByText('Approval timed out')).toBeInTheDocument();
    expect(within(table).getByText('Reason not recorded')).toBeInTheDocument();
  });

  it('shows the no-runs-yet empty state with a link to add a source when there is no filter', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    const title = await screen.findByText('No runs yet');
    expect(title).toBeInTheDocument();
    // The earned-zero-inbox treatment distinguishes "nothing has ever run" from a filter that
    // simply matches nothing.
    expect(title.closest('.empty-state--zero')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a source' })).toHaveAttribute('href', '/sources');
    // 1C records a run at every workflow start, so this sentence is verified true — not rewritten.
    expect(
      screen.getByText(
        'Runs appear here once a question, ingestion, sync, or conflict resolution starts.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a filter-specific empty state with a Show-all action when a filter matches nothing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      if (
        url === '/api/v1/workflow-runs?status=failed&skip=0&limit=25&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });

    const title = await screen.findByText('No runs match this filter');
    expect(title).toBeInTheDocument();
    expect(title.closest('.empty-state--zero')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add a source' })).not.toBeInTheDocument();

    const showAll = screen.getByRole('button', { name: 'Show all runs' });
    fireEvent.click(showAll);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });
    expect(await screen.findByRole('link', { name: 'Source sync' })).toBeInTheDocument();
  });

  it('applies the status and type filters as query parameters, not client-side', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc' ||
        url === '/api/v1/workflow-runs?status=failed&skip=0&limit=25&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      if (
        url ===
        '/api/v1/workflow-runs?status=failed&workflowType=resolve-conflict&skip=0&limit=25&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    // Each select applies as it changes, so the type request carries the status already applied.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url ===
            '/api/v1/workflow-runs?status=failed&skip=0&limit=25&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'resolve-conflict' } });

    await screen.findByRole('link', { name: 'Conflict resolution' });

    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url ===
          '/api/v1/workflow-runs?status=failed&workflowType=resolve-conflict&skip=0&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
  });

  it('resets paging to the first page in the same patch as applying a filter, and keeps the URL clean at defaults', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 30 }));
      }
      if (url === '/api/v1/workflow-runs?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 30 }));
      }
      if (
        url === '/api/v1/workflow-runs?status=failed&skip=0&limit=25&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    // A page at its defaults keeps a clean address bar.
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('26–30 of 30');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });

    await screen.findByText('1–1 of 1');

    // The filter landed and paging reset to the first page in the same patch — the URL carries
    // only the non-default `status`, never a leftover `skip`.
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      '?status=failed',
    );
  });

  it('reproduces a filtered, sorted, paged view from a deep link', async () => {
    stubFetch({
      '/api/v1/workflow-runs?status=failed&skip=25&limit=25&sort=status&sortDir=asc': () =>
        jsonResponse({ docs: [failedRun], count: 30 }),
    });

    renderPage(['/workflow-runs?status=failed&sort=status&sortDir=asc&skip=25']);

    await screen.findByRole('link', { name: 'Conflict resolution' });
    expect(screen.getByLabelText('Status')).toHaveValue('failed');
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('sorts by a column on click, defaulting to descending and toggling on the active column', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc' ||
        url === '/api/v1/workflow-runs?skip=0&limit=25&sort=status&sortDir=desc' ||
        url === '/api/v1/workflow-runs?skip=0&limit=25&sort=status&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Status' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/workflow-runs?skip=0&limit=25&sort=status&sortDir=desc',
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Status, sorted descending' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/workflow-runs?skip=0&limit=25&sort=status&sortDir=asc',
        ),
      ).toBe(true);
    });
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 30 }));
      }
      if (url === '/api/v1/workflow-runs?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 30 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('26–30 of 30');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/workflow-runs?skip=25&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('shows an error when the runs fail to load, and keeps that error separate from an empty result', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ message: 'Runs unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Runs unavailable');
  });

  it('keeps already-loaded rows on screen when a later refresh fails, rather than blanking them', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=status&sortDir=desc') {
        return Promise.resolve(jsonResponse({ message: 'Runs unavailable' }, 500));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Status' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Runs unavailable');
    expect(screen.getByRole('link', { name: 'Source sync' })).toBeInTheDocument();
  });

  it('labels the legacy rescan-conflicts type as an option, not as a type the system still produces', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun], count: 1 }),
    });

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    expect(screen.getByRole('option', { name: 'Conflict rescan (legacy)' })).toBeInTheDocument();
  });

  it('renders no Triggered-by column in the list view', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun], count: 1 }),
    });

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    expect(screen.queryByText('Triggered by')).not.toBeInTheDocument();
  });

  it('sizes Type and Created as fixed columns, leaving Status to absorb the rest', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun], count: 1 }),
    });

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    const cols = screen.getByRole('table').querySelectorAll('col');
    expect(cols).toHaveLength(3);
    expect(cols[0]).toHaveClass('col-wide');
    expect(cols[1]).not.toHaveAttribute('class');
    expect(cols[2]).toHaveClass('col-narrow');
    expect(screen.getByRole('table')).toHaveClass('runs-grid');
  });

  it('drops a slow earlier response when a newer sort has already landed', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return first.promise;
      }
      if (
        url === '/api/v1/workflow-runs?status=failed&skip=0&limit=25&sort=createdAt&sortDir=desc'
      ) {
        return second.promise;
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    expect(screen.getByText('Loading workflow runs…')).toBeInTheDocument();

    // Changing a filter starts a second, newer fetch while the first is still in flight.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });

    // The newer request settles first.
    second.resolve(jsonResponse({ docs: [failedRun], count: 1 }));
    await screen.findByRole('link', { name: 'Conflict resolution' });

    // The superseded, older request settles after and must not overwrite the newer rows.
    first.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole('link', { name: 'Conflict resolution' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Source sync' })).not.toBeInTheDocument();
  });

  it('changing the page size issues the new limit and resets skip to the first page', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 60 }));
      }
      if (url === '/api/v1/workflow-runs?skip=0&limit=50&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 60 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/workflow-runs?skip=25']);
    await screen.findByRole('link', { name: 'Conflict resolution' });

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });

    await screen.findByRole('link', { name: 'Source sync' });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/workflow-runs?skip=0&limit=50&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
  });

  it('applies the Last 7 days preset as range=7d, requesting whole local days, and Clear resets it', async () => {
    // Only `Date` is faked, so "today" is fixed while the page's own timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 15, 30));
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      if (url.includes('from=')) {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: '7d' },
    });

    await screen.findByRole('link', { name: 'Conflict resolution' });
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent('?range=7d');

    const call = fetchMock.mock.calls.find(([url]) => url.includes('from='));
    expect(call).toBeDefined();
    const requestUrl = new URL(call![0], 'http://localhost');
    const from = requestUrl.searchParams.get('from');
    const to = requestUrl.searchParams.get('to');
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    // Local midnight six days before today through the exclusive bound at local midnight tomorrow:
    // seven whole days including today, on any host timezone.
    expect(from).toBe(new Date(2026, 8, 8).toISOString());
    expect(to).toBe(new Date(2026, 8, 15).toISOString());
    expect(new Date(to!).getTime() - new Date(from!).getTime()).toBe(7 * 24 * 60 * 60 * 1000);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await screen.findByRole('link', { name: 'Source sync' });
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
    expect(screen.getByRole('combobox', { name: 'Created' })).toHaveValue('');
  });

  it('reads a from date without a range as a custom range with From filled', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('from=')) {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/workflow-runs?from=2026-09-01']);
    await screen.findByRole('link', { name: 'Conflict resolution' });

    expect(screen.getByRole('combobox', { name: 'Created' })).toHaveValue('custom');
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveValue('');
    const requestUrl = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(requestUrl.searchParams.get('from')).toBe(new Date(2026, 8, 1).toISOString());
    expect(requestUrl.searchParams.has('to')).toBe(false);
  });

  it('renders the list for an unparseable from date and sends no from', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun], count: 1 }),
    });

    renderPage(['/workflow-runs?from=garbage']);

    await screen.findByRole('link', { name: 'Source sync' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Created' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('treats revealing an empty Custom range as no filter: no refetch and no Clear filters', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });

    expect(await screen.findByLabelText('From')).toHaveValue('');
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      '?range=custom',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('reveals an empty Custom range on page 2 without refetching or resetting skip', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 30 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/workflow-runs?skip=25']);
    await screen.findByRole('link', { name: 'Source sync' });
    const callsBeforeReveal = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.length).toBe(callsBeforeReveal);
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(/skip=25/);
  });

  it('blocks a From after To from reaching the API and keeps the last valid results', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      if (url.includes('from=') && !url.includes('to=')) {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-20' } });
    await screen.findByRole('link', { name: 'Conflict resolution' });
    const callsBeforeInvertedTo = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-10' } });

    const toField = screen.getByLabelText('To');
    expect(toField).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('From must be on or before To.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeInvertedTo);
    expect(screen.getByRole('link', { name: 'Conflict resolution' })).toBeInTheDocument();
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun], count: 1 }),
    });

    renderPage(['/workflow-runs?sort=bogus&sortDir=up']);

    await screen.findByRole('link', { name: 'Source sync' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('clamps an out-of-range limit and a negative skip from the URL to the defaults', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun], count: 1 }),
    });

    renderPage(['/workflow-runs?limit=7&skip=-1']);

    await screen.findByRole('link', { name: 'Source sync' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Rows per page')).toHaveValue('25');
  });

  it('announces the result count once after a filter change, and nothing on the first load', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 1 }));
      }
      if (
        url === '/api/v1/workflow-runs?status=failed&skip=0&limit=25&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const messages: string[] = [];
    subscribeAnnouncements((message) => messages.push(message));

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });
    expect(messages).toEqual([]);

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });

    await screen.findByRole('link', { name: 'Conflict resolution' });
    expect(messages).toEqual(['1 run']);
  });
});
