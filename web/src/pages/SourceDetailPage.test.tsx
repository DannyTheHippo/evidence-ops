import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, getToasts } from '../components/ui/toast';
import SourceDetailPage from './SourceDetailPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GET_URL = '/api/v1/sources/source-1';

const sourceWithFileStates = {
  id: 'source-1',
  name: 'Deal Room Inbox',
  kind: 'local-folder',
  path: 'deal-room',
  enabled: true,
  lastSyncAt: '2026-08-01T12:00:00.000Z',
  lastSyncStatus: 'failed',
  lastSyncError: 'connector refused an oversized file',
  fileCount: 2,
  createdAt: new Date().toISOString(),
  fileStates: [
    {
      path: 'contracts/lease-agreement.pdf',
      status: 'ok',
      mtimeMs: 1_753_920_000_000,
    },
    {
      path: 'contracts/broken-scan.pdf',
      status: 'failed',
      lastError: "Could not resolve a document type for 'contracts/broken-scan.pdf'",
      mtimeMs: 1_753_920_100_000,
    },
  ],
};

function renderAt(id: string) {
  render(
    <MemoryRouter initialEntries={[`/sources/${id}`]}>
      <Routes>
        <Route path="/sources/:id" element={<SourceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SourceDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearToasts();
  });

  it('shows a loading state before the source arrives', async () => {
    let resolveSource: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSource = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    resolveSource!(jsonResponse(sourceWithFileStates));

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('shows a failing file and its error, distinct from an ok file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sourceWithFileStates));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByText('contracts/lease-agreement.pdf')).toBeInTheDocument();
    expect(screen.getByText('contracts/broken-scan.pdf')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(
      screen.getByText("Could not resolve a document type for 'contracts/broken-scan.pdf'"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Per-file sync status for this source' }),
    ).toBeInTheDocument();
  });

  it('shows "Source not found" for a 404, not the generic error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Source 'source-1' not found" }, 404));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByText('Source not found.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the load error for a non-404 failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Source unavailable' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Source unavailable');
  });

  it('surfaces the sync interval and a carried sync error in the caution register', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...sourceWithFileStates, intervalMs: 300_000 }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByText('Every 5 minutes')).toBeInTheDocument();
    expect(
      screen.getByText('Last sync failed: connector refused an oversized file'),
    ).toBeInTheDocument();
  });

  it('shows a default-interval label for a source with no configured interval', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sourceWithFileStates));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByText('Default interval')).toBeInTheDocument();
  });

  it('enables and disables the source without leaving the page', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...sourceWithFileStates, enabled: false }));
      }
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
    const toggleCall = fetchMock.mock.calls.find(
      ([url, init]) => url === GET_URL && init?.method === 'PATCH',
    );
    expect(toggleCall).toBeDefined();
    expect(JSON.parse((toggleCall?.[1] as RequestInit).body as string)).toEqual({
      enabled: false,
    });
  });

  it('shows an error when toggling the source fails, without blocking further attempts', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === GET_URL && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ message: 'Failed to update source' }, 500));
      }
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update source');
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('starts a sync from the detail page, links to the resulting workflow run, and toasts the result', async () => {
    const run = {
      id: 'run-1',
      workflowId: 'wf-1',
      status: 'completed' as const,
      createdAt: new Date().toISOString(),
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === '/api/v1/sources/source-1/sync') return Promise.resolve(jsonResponse(run, 201));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    const link = await screen.findByRole('link', { name: 'Sync completed' });
    expect(link).toHaveAttribute('href', '/workflow-runs/run-1');
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Sync started for Deal Room Inbox.' }),
    );
  });

  it('shows an error when the sync request fails, without blocking further attempts', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === '/api/v1/sources/source-1/sync') {
        return Promise.resolve(jsonResponse({ message: 'Sync already in progress' }, 409));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sync already in progress');
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeDisabled();
  });
});
