import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RunsPage from './RunsPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('names each run by workflow type, keeping the opaque id as secondary detail', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun, failedRun, untypedRun], count: 3 }),
    });

    renderPage();

    expect(screen.getByText('Loading workflow runs…')).toBeInTheDocument();

    expect(
      await screen.findByRole('table', { name: 'Workflow runs, most recent first' }),
    ).toBeInTheDocument();

    // The link text is the human label, not the uuid — that is the whole point of the column.
    const completedLink = screen.getByRole('link', { name: 'Source sync' });
    expect(completedLink).toHaveAttribute('href', '/workflow-runs/run-1');
    expect(screen.getByText('completed')).toBeInTheDocument();

    const failedLink = screen.getByRole('link', { name: 'Conflict resolution' });
    expect(failedLink).toHaveAttribute('href', '/workflow-runs/run-2');
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('Model timeout')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Workflow run' })).toHaveAttribute(
      'href',
      '/workflow-runs/run-3',
    );

    // The id stays on screen, shortened, with the full value recoverable on hover.
    expect(screen.getByTitle('wf-1')).toHaveTextContent('wf-1');
  });

  it('shows the no-runs-yet empty state with a link to Ask when there is no filter', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask a question' })).toHaveAttribute('href', '/ask');
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
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('No runs match this filter')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ask a question' })).not.toBeInTheDocument();

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
      if (url === '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc') {
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

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'resolve-conflict' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

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
    await screen.findByText('30 total');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await screen.findByText('1 total');

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
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
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

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('30 total');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/workflow-runs?skip=25&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
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

  it('renders no Triggered-by column, since no writer of a resolve-conflict or sync-source run sets a subject', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [completedRun], count: 1 }),
    });

    renderPage();
    await screen.findByRole('link', { name: 'Source sync' });

    expect(screen.queryByText('Triggered by')).not.toBeInTheDocument();
  });
});
