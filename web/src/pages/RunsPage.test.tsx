import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

function renderRunsPage() {
  return render(
    <MemoryRouter>
      <RunsPage />
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
      '/api/v1/workflow-runs?skip=0&limit=25': () =>
        jsonResponse({ docs: [completedRun, failedRun, untypedRun], count: 3 }),
    });

    renderRunsPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

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

  it('shows an empty state with a link to Ask when no runs exist', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderRunsPage();

    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask a question' })).toHaveAttribute('href', '/ask');
  });

  it('shows an error when the runs fail to load', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25': () =>
        jsonResponse({ message: 'Runs unavailable' }, 500),
    });

    renderRunsPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Runs unavailable');
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [completedRun], count: 30 }));
      }
      if (url === '/api/v1/workflow-runs?skip=25&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [failedRun], count: 30 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderRunsPage();
    await screen.findByText('completed');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('30 total');
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/workflow-runs?skip=25&limit=25'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });
});
