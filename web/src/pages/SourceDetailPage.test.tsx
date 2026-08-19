import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
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
const ME_URL = '/api/v1/auth/me';

const admin = {
  id: 'user-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  createdAt: new Date().toISOString(),
};

const member = {
  id: 'user-2',
  email: 'member@example.com',
  role: 'member' as const,
  createdAt: new Date().toISOString(),
};

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
  connectivity: 'connector',
  reachability: 'live',
  owner: 'Jane Doe, IT',
  tracked: true,
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

// Dispatches by URL and method, matching DocumentDetail.test.tsx's stubFetch shape. Every route
// not given here 404s except /auth/me, which defaults to an admin so most tests exercise the
// gated controls without repeating the session stub.
function stubFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
  session: (init?: RequestInit) => Response | Promise<Response> = () => jsonResponse(admin),
): void {
  const defaults: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {
    [ME_URL]: session,
    ...routes,
  };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = defaults[url];
    if (!handler)
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

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
    clearSession();
    clearToasts();
  });

  it('shows a loading state before the source arrives', async () => {
    let resolveSource: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSource = resolve;
    });
    stubFetch({
      [GET_URL]: () => pending,
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    expect(screen.getByText('Loading source…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading source…');

    resolveSource!(jsonResponse(sourceWithFileStates));

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(screen.queryByText('Loading source…')).not.toBeInTheDocument();
  });

  it('shows a failing file and its error, distinct from an ok file', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

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
    stubFetch({
      [GET_URL]: () => jsonResponse({ message: "Source 'source-1' not found" }, 404),
    });

    renderAt('source-1');

    expect(await screen.findByText('Source not found.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the load error for a non-404 failure', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse({ message: 'Source unavailable' }, 500),
    });

    renderAt('source-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Source unavailable');
  });

  it('surfaces the sync interval and a carried sync error in the caution register', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse({ ...sourceWithFileStates, intervalMs: 300_000 }),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    expect(await screen.findByText('Every 5 minutes')).toBeInTheDocument();
    expect(
      screen.getByText('Last sync failed: connector refused an oversized file'),
    ).toBeInTheDocument();
  });

  it('shows a default-interval label for a source with no configured interval', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    expect(await screen.findByText('Default interval')).toBeInTheDocument();
  });

  it('enables and disables the source without leaving the page', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
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
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
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
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
    });

    renderAt('source-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    const link = await screen.findByRole('link', { name: 'Synced' });
    expect(link).toHaveAttribute('href', '/workflow-runs/run-1');
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Sync started for Deal Room Inbox.' }),
    );
  });

  it('shows an error when the sync request fails, without blocking further attempts', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
      '/api/v1/sources/source-1/sync': () =>
        jsonResponse({ message: 'Sync already in progress' }, 409),
    });

    renderAt('source-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sync already in progress');
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeDisabled();
  });

  it('shows no class drift card when sourceClass has never changed', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    expect(screen.queryByText('Class drift')).not.toBeInTheDocument();
  });

  it('shows the drift card with the count read from one server value, opens and cancels the dialog', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ previousClass: 'memo', count: 2 }),
    });

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
  });

  it('applies the drift, toasts the servers modifiedCount, and re-fetches so the card disappears', async () => {
    let driftCall = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
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
    // The re-fetch after apply reports count: 0, so the card disappears with the number rather
    // than being patched locally to some derived value.
    expect(screen.queryByText('Class drift')).not.toBeInTheDocument();
    expect(driftCall).toBe(2);
  });

  it('shows an apply error inside the still-open dialog, then clears it the next time the dialog opens', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ previousClass: 'memo', count: 2 }),
      [APPLY_DRIFT_URL]: () => jsonResponse({ message: 'Failed to apply class drift' }, 500),
    });

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

  it('pre-fills the inventory form from the loaded source and saves an edit', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL && init?.method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({ ...sourceWithFileStates, owner: 'New Owner', reachability: 'possible' }),
        );
      }
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByDisplayValue('Jane Doe, IT')).toBeInTheDocument();
    expect(screen.getByLabelText('Connectivity')).toHaveValue('connector');
    expect(screen.getByLabelText('Reachability')).toHaveValue('live');
    expect(screen.getByLabelText('Class')).toHaveValue('crm-export');
    expect(screen.getByLabelText('Tracked')).toHaveValue('true');

    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'New Owner' } });
    fireEvent.change(screen.getByLabelText('Reachability'), { target: { value: 'possible' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save inventory details' }));

    await waitFor(() => {
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ kind: 'success', message: 'Updated inventory details.' }),
      );
    });
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => url === GET_URL && init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall?.[1] as RequestInit).body as string)).toEqual({
      owner: 'New Owner',
      connectivity: 'connector',
      reachability: 'possible',
      tracked: true,
      sourceClass: 'crm-export',
    });
  });

  it('shows an error when saving the inventory form fails', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ message: 'Failed to update inventory' }, 500));
      }
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    await screen.findByDisplayValue('Jane Doe, IT');
    fireEvent.click(screen.getByRole('button', { name: 'Save inventory details' }));

    expect(await screen.findByText('Failed to update inventory')).toBeInTheDocument();
  });

  it('a member sees why they cannot edit inventory details or the enable toggle, but still sees Sync now', async () => {
    stubFetch(
      {
        [GET_URL]: () => jsonResponse(sourceWithFileStates),
        [DRIFT_URL]: () => jsonResponse({ count: 0 }),
      },
      () => jsonResponse(member),
    );

    renderAt('source-1');

    expect(
      await screen.findByText('Editing inventory details requires an admin.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Owner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it('a member sees the class drift count but not the apply control, matching the server-side 403', async () => {
    stubFetch(
      {
        [GET_URL]: () => jsonResponse(sourceWithFileStates),
        [DRIFT_URL]: () => jsonResponse({ previousClass: 'memo', count: 2 }),
      },
      () => jsonResponse(member),
    );

    renderAt('source-1');

    // Reading the drift count stays open to every role — only the apply control is admin-only.
    expect(
      await screen.findByText('2 documents still carry the previous class (memo).'),
    ).toBeInTheDocument();
    expect(screen.getByText('Applying class drift requires an admin.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Apply current class to 2 documents' }),
    ).not.toBeInTheDocument();
  });

  it('withholds the admin-only notice until the session probe resolves, then admits the admin', async () => {
    let resolveMe: (res: Response) => void;
    const pendingMe = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });
    stubFetch(
      {
        [GET_URL]: () => jsonResponse(sourceWithFileStates),
        [DRIFT_URL]: () => jsonResponse({ count: 0 }),
      },
      () => pendingMe,
    );

    renderAt('source-1');

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(
      screen.queryByText('Editing inventory details requires an admin.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Owner')).not.toBeInTheDocument();

    act(() => {
      resolveMe!(jsonResponse(admin));
    });

    expect(await screen.findByLabelText('Owner')).toBeInTheDocument();
    expect(
      screen.queryByText('Editing inventory details requires an admin.'),
    ).not.toBeInTheDocument();
  });
});
