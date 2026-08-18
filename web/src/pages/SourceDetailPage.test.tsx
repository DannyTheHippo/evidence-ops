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
const DRIFT_URL = '/api/v1/sources/source-1/class-drift';
const APPLY_DRIFT_URL = '/api/v1/sources/source-1/class-drift/apply';

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
  sourceClass: 'crm-export',
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
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
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
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
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
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
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
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
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

  it('shows no class drift card when sourceClass has never changed', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    expect(screen.queryByText('Class drift')).not.toBeInTheDocument();
  });

  it('shows the drift card with the count read from one server value, opens and cancels the dialog', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) {
        return Promise.resolve(jsonResponse({ previousClass: 'memo', count: 2 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    const opener = await screen.findByRole('button', {
      name: 'Apply current class to 2 documents',
    });
    expect(
      screen.getByText('2 documents still carry the previous class (memo).'),
    ).toBeInTheDocument();

    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Apply current class to 2 documents?' });
    expect(screen.getByRole('button', { name: 'Apply to 2 documents' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('This applies crm-export to every document');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('applies the drift, toasts the servers modifiedCount, and re-fetches so the card disappears', async () => {
    let driftCall = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) {
        driftCall += 1;
        return Promise.resolve(
          jsonResponse(driftCall === 1 ? { previousClass: 'memo', count: 2 } : { count: 0 }),
        );
      }
      if (url === APPLY_DRIFT_URL && init?.method === 'POST') {
        // The server's modifiedCount (3) deliberately differs from the pre-flight count (2) —
        // a sync landing in between is exactly the case the toast must reflect honestly.
        return Promise.resolve(
          jsonResponse({ modifiedCount: 3, previousClass: 'memo', sourceClass: 'crm-export' }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Apply current class to 2 documents' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 documents' }));

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getToasts()).toContainEqual(
      expect.objectContaining({
        kind: 'success',
        message: 'Applied crm-export to 3 documents.',
      }),
    );
    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    // The re-fetch after apply reports count: 0, so the card disappears with the number rather
    // than being patched locally to some derived value.
    expect(screen.queryByText('Class drift')).not.toBeInTheDocument();
    expect(driftCall).toBe(2);
  });

  it('shows an apply error inside the still-open dialog, then clears it the next time the dialog opens', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) {
        return Promise.resolve(jsonResponse({ previousClass: 'memo', count: 2 }));
      }
      if (url === APPLY_DRIFT_URL && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'Failed to apply class drift' }, 500));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Apply current class to 2 documents' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 documents' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Apply current class to 2 documents?',
    });
    expect(dialog).toHaveTextContent('Failed to apply class drift');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply current class to 2 documents' }));
    const reopened = screen.getByRole('dialog', { name: 'Apply current class to 2 documents?' });
    expect(reopened).not.toHaveTextContent('Failed to apply class drift');
  });
});
