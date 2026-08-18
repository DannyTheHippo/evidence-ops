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
  status: 'completed' as const,
  createdAt: '2026-08-01T12:00:00.000Z',
};

const failedRun = {
  id: 'run-2',
  workflowId: 'wf-2',
  status: 'failed' as const,
  currentStep: 'extract_facts',
  errorMessage: 'Model timeout',
  createdAt: '2026-08-02T09:30:00.000Z',
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

  it('lists runs with workflow id, status, current step and created date', async () => {
    stubFetch({
      '/api/v1/workflow-runs?skip=0&limit=25': () =>
        jsonResponse({ docs: [completedRun, failedRun], count: 2 }),
    });

    renderRunsPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    expect(
      await screen.findByRole('table', { name: 'Workflow runs, most recent first' }),
    ).toBeInTheDocument();

    const completedLink = screen.getByRole('link', { name: 'wf-1' });
    expect(completedLink).toHaveAttribute('href', '/workflow-runs/run-1');
    expect(screen.getByText('completed')).toBeInTheDocument();
    // Placeholder for the completed run's absent currentStep.
    expect(screen.getByText('—')).toBeInTheDocument();

    const failedLink = screen.getByRole('link', { name: 'wf-2' });
    expect(failedLink).toHaveAttribute('href', '/workflow-runs/run-2');
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('extract_facts')).toBeInTheDocument();
    expect(screen.getByText('Model timeout')).toBeInTheDocument();
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
