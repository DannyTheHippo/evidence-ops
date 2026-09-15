import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import { getBreadcrumbTrail } from '../lib/breadcrumbs';
import { formatRelativeTimestamp } from '../lib/format-timestamp';
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

function renderAt(id: string, pollIntervalMs?: number) {
  render(
    <MemoryRouter initialEntries={[`/sources/${id}`]}>
      <Routes>
        <Route path="/sources/:id" element={<SourceDetailPage pollIntervalMs={pollIntervalMs} />} />
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

  it('leads with health, not the filesystem path — path renders as metadata further down', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    const heading = await screen.findByRole('heading', { name: 'Sync health' });
    expect(heading.tagName).toBe('H2');
    const path = screen.getByText('deal-room');
    expect(path.className).toContain('mono');
    expect(path.className).toContain('cell-sub');
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
    const lastError = screen.getByText(
      "Could not resolve a document type for 'contracts/broken-scan.pdf'",
    );
    // Truncated in its cell, so keyboard focus on it opens the full error.
    expect(lastError).toHaveAttribute('tabindex', '0');
    lastError.focus();
    const errorTooltip = await screen.findByRole('tooltip');
    expect(errorTooltip).toHaveTextContent(
      "Could not resolve a document type for 'contracts/broken-scan.pdf'",
    );
    expect(lastError).toHaveAttribute('aria-describedby', errorTooltip.id);
    expect(
      screen.getByRole('table', { name: 'Per-file sync status for this source' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Per-file sync status for this source' }),
    ).toHaveAttribute('tabindex', '0');
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

  it('surfaces the sync interval, the last-sync time and a carried sync error in the caution register', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse({ ...sourceWithFileStates, intervalMs: 300_000 }),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    expect(await screen.findByText('Every 5 minutes')).toBeInTheDocument();
    expect(
      screen.getByText(formatRelativeTimestamp(sourceWithFileStates.lastSyncAt)),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Last sync failed: connector refused an oversized file'),
    ).toBeInTheDocument();
    expect(screen.getByText('Files').closest('.stat-row-item')).toHaveTextContent(
      String(sourceWithFileStates.fileCount),
    );
  });

  it('shows "Never synced" rather than a Timestamp when the source has never synced', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse({ ...sourceWithFileStates, lastSyncAt: undefined }),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    expect(await screen.findByText('Never synced')).toBeInTheDocument();
  });

  it('shows a default-interval label for a source with no configured interval', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    expect(await screen.findByText('Default interval')).toBeInTheDocument();
  });

  it('shows a neutral pending-drift stat when the source carries none', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    const value = screen
      .getByText('Pending drift')
      .closest('.stat-row-item')
      ?.querySelector('.stat-row-value');
    expect(value).toHaveTextContent('0');
    expect(value?.className).not.toContain('stat-row-value--caution');
  });

  it('shows a caution pending-drift stat when the source carries some', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ previousClass: 'memo', count: 2 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    const value = screen
      .getByText('Pending drift')
      .closest('.stat-row-item')
      ?.querySelector('.stat-row-value');
    expect(value).toHaveTextContent('2');
    expect(value?.className).toContain('stat-row-value--caution');
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
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    const toggleCall = fetchMock.mock.calls.find(
      ([url, init]) => url === GET_URL && init?.method === 'PATCH',
    );
    expect(toggleCall).toBeDefined();
    expect(JSON.parse((toggleCall?.[1] as RequestInit).body as string)).toEqual({
      enabled: false,
    });
  });

  it('shows the shared Saving… busy label while toggling, keeping the button named for its action', async () => {
    let resolvePatch!: (res: Response) => void;
    const patch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL && init?.method === 'PATCH') return patch;
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    const toggle = await screen.findByRole('button', { name: 'Disable' });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveTextContent('Saving…'));
    expect(toggle).toHaveAccessibleName('Disable');
    expect(toggle).toHaveAttribute('aria-busy', 'true');

    resolvePatch(jsonResponse({ ...sourceWithFileStates, enabled: false }));
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
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

    const link = await screen.findByRole('link', { name: 'Sync loop stopped' });
    expect(link).toHaveAttribute('href', '/workflow-runs/run-1');
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Sync requested for Deal Room Inbox.' }),
    );
  });

  it('reloads the source and drift count once the sweep it requested settles, without a manual reload', async () => {
    let sourceCall = 0;
    let driftCall = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL) {
        sourceCall += 1;
        // The first two reads (initial load, then the poll's first tick) still carry the
        // sync-before-request timestamp; only the third reflects a sweep that started after
        // `startSync` recorded its own `requestedAt` — matching use-source-sync.test.ts's shape.
        return Promise.resolve(
          jsonResponse(
            sourceCall < 3
              ? sourceWithFileStates
              : {
                  ...sourceWithFileStates,
                  lastSyncAt: new Date().toISOString(),
                  lastSyncError: undefined,
                  lastSyncStatus: 'ok',
                },
          ),
        );
      }
      if (url === DRIFT_URL) {
        driftCall += 1;
        return Promise.resolve(jsonResponse({ count: 0 }));
      }
      if (url === '/api/v1/sources/source-1/sync') {
        return Promise.resolve(
          jsonResponse(
            {
              id: 'run-1',
              workflowId: 'wf-1',
              status: 'completed',
              createdAt: new Date().toISOString(),
            },
            201,
          ),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1', 5);

    expect(
      await screen.findByText('Last sync failed: connector refused an oversized file'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(
        screen.queryByText('Last sync failed: connector refused an oversized file'),
      ).not.toBeInTheDocument();
    });
    expect(sourceCall).toBeGreaterThanOrEqual(3);
    expect(driftCall).toBeGreaterThanOrEqual(2);
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

  it('shows the shared Syncing… busy label while a sync is pending, keeping the button named and focused', async () => {
    let resolveSync!: (res: Response) => void;
    const sync = new Promise<Response>((resolve) => {
      resolveSync = resolve;
    });
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
      '/api/v1/sources/source-1/sync': () => sync,
    });

    renderAt('source-1');

    const syncButton = await screen.findByRole('button', { name: 'Sync now' });
    // jsdom synthesizes no click from a key press, so keyboard activation is a focused button
    // receiving the click Enter or Space would dispatch.
    syncButton.focus();
    fireEvent.click(syncButton);

    await waitFor(() => expect(syncButton).toHaveTextContent('Syncing…'));
    expect(syncButton).toHaveAccessibleName('Sync now');
    expect(syncButton).toHaveAttribute('aria-busy', 'true');
    expect(syncButton).not.toBeDisabled();
    expect(syncButton).toHaveFocus();

    resolveSync(
      jsonResponse(
        {
          id: 'run-1',
          workflowId: 'wf-1',
          status: 'completed',
          createdAt: new Date().toISOString(),
        },
        201,
      ),
    );
    expect(await screen.findByRole('link', { name: 'Sync loop stopped' })).toBeInTheDocument();
  });

  it('shows no class drift card when sourceClass has never changed', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    expect(screen.queryByRole('heading', { name: 'Class drift' })).not.toBeInTheDocument();
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
      screen.getByText('2 documents still carry the previous class (Memo).'),
    ).toBeInTheDocument();

    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Apply current class to 2 documents?' });
    expect(screen.getByRole('button', { name: 'Apply to 2 documents' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('This applies CRM export to every document');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the class drift dialog focused on Cancel, not Apply', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ previousClass: 'memo', count: 2 }),
    });

    renderAt('source-1');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Apply current class to 2 documents' }),
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Apply to 2 documents' })).not.toHaveFocus();
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

    const opener = await screen.findByRole('button', {
      name: 'Apply current class to 2 documents',
    });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 documents' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Class drift' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Deal Room Inbox')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The apply removed the focused button that opened the dialog, so focus lands on the per-file
    // panel that takes the removed card's place instead of dropping to the document body.
    expect(
      screen.getByRole('region', { name: 'Per-file sync status for this source' }),
    ).toHaveFocus();
    expect(getToasts()).toContainEqual(
      expect.objectContaining({
        kind: 'success',
        message: 'Applied CRM export to 3 documents.',
      }),
    );
    // The re-fetch after apply reports count: 0, so the card disappears with the number rather
    // than being patched locally to some derived value.
    expect(screen.queryByRole('heading', { name: 'Class drift' })).not.toBeInTheDocument();
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
    let resolvePatch!: (res: Response) => void;
    const patch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL && init?.method === 'PATCH') return patch;
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByDisplayValue('Jane Doe, IT')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Connector/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Live/ })).toBeChecked();
    expect(screen.getByLabelText('Class')).toHaveValue('crm-export');
    expect(screen.getByRole('radio', { name: /^Synced by a connector/ })).toBeChecked();

    fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'New Owner' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Possible/ }));
    const saveButton = screen.getByRole('button', { name: 'Save inventory details' });
    saveButton.focus();
    fireEvent.click(saveButton);

    await waitFor(() => expect(saveButton).toHaveTextContent('Saving…'));
    expect(saveButton).toHaveAccessibleName('Save inventory details');
    expect(saveButton).toHaveAttribute('aria-busy', 'true');
    expect(saveButton).not.toBeDisabled();
    expect(saveButton).toHaveFocus();

    resolvePatch(
      jsonResponse({ ...sourceWithFileStates, owner: 'New Owner', reachability: 'possible' }),
    );
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
    expect(screen.queryByLabelText(/^Owner/)).not.toBeInTheDocument();
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
      await screen.findByText('2 documents still carry the previous class (Memo).'),
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
    expect(screen.queryByLabelText(/^Owner/)).not.toBeInTheDocument();

    act(() => {
      resolveMe!(jsonResponse(admin));
    });

    expect(await screen.findByLabelText(/^Owner/)).toBeInTheDocument();
    expect(
      screen.queryByText('Editing inventory details requires an admin.'),
    ).not.toBeInTheDocument();
  });

  it('clears the owner when the field is emptied', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...sourceWithFileStates, owner: undefined }));
      }
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceWithFileStates));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByDisplayValue('Jane Doe, IT')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: '' } });
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
      owner: null,
      connectivity: 'connector',
      reachability: 'live',
      tracked: true,
      sourceClass: 'crm-export',
    });
  });

  it('shows no sync controls for an mcp-submit source, and says why', async () => {
    stubFetch({
      [GET_URL]: () =>
        jsonResponse({
          ...sourceWithFileStates,
          kind: 'mcp-submit',
          tracked: false,
          enabled: false,
        }),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    expect(
      await screen.findByText('Evidence arrives through the MCP surface; no sync loop runs.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.queryByText('Cadence')).not.toBeInTheDocument();
  });

  it('publishes a Sources › name breadcrumb trail', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');

    // The trail publishes from a passive effect keyed on its own content, one render after the
    // source name that effect reads.
    await waitFor(() => {
      expect(getBreadcrumbTrail()).toEqual([
        { label: 'Sources', to: '/sources' },
        { label: 'Deal Room Inbox' },
      ]);
    });
  });

  it('shows the next scheduled sweep from lastSync', async () => {
    const nextSweepAt = new Date(Date.now() + 5 * 60_000).toISOString();
    stubFetch({
      [GET_URL]: () =>
        jsonResponse({
          ...sourceWithFileStates,
          lastSync: {
            startedAt: sourceWithFileStates.lastSyncAt,
            finishedAt: sourceWithFileStates.lastSyncAt,
            status: 'failed',
            error: sourceWithFileStates.lastSyncError,
            nextSweepAt,
          },
        }),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    expect(screen.getByText('Next sweep').closest('.stat-row-item')).toHaveTextContent(
      formatRelativeTimestamp(nextSweepAt),
    );
  });

  it('names the drift classes in human labels, not raw enum values', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ previousClass: 'memo', count: 2 }),
    });

    renderAt('source-1');

    expect(await screen.findByText('Memo → CRM export')).toBeInTheDocument();
    expect(
      screen.getByText('2 documents still carry the previous class (Memo).'),
    ).toBeInTheDocument();
  });

  it('shows the drift load failure beside the pending-drift stat', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ message: 'Failed to load class drift' }, 500),
    });

    renderAt('source-1');

    const alertText = await screen.findByText('Failed to load class drift');
    const syncHealthCard = screen.getByRole('heading', { name: 'Sync health' }).closest('.card');
    expect(syncHealthCard).toContainElement(alertText);
  });

  it('names the source kind on the metadata list', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    expect(screen.getByText('Kind')).toBeInTheDocument();
    expect(screen.getByText('Local folder')).toBeInTheDocument();
    expect(screen.getByText('Path')).toBeInTheDocument();
  });

  it('labels an mcp-submit path as its submitting client', async () => {
    stubFetch({
      [GET_URL]: () =>
        jsonResponse({ ...sourceWithFileStates, kind: 'mcp-submit', tracked: false }),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    await screen.findByText('Deal Room Inbox');
    expect(screen.getByText('Kind').closest('.description-list-item')).toHaveTextContent(
      'MCP submission',
    );
    expect(screen.getByText('Submitting client')).toBeInTheDocument();
    expect(screen.queryByText('Path')).not.toBeInTheDocument();
  });

  it('drops a deferred response for the previous source after navigating to a new one', async () => {
    const sourceOne = { ...sourceWithFileStates, id: 'source-1', name: 'Source One' };
    const sourceTwo = {
      ...sourceWithFileStates,
      id: 'source-2',
      name: 'Source Two',
      owner: 'Owner Two',
    };
    const GET_URL_2 = '/api/v1/sources/source-2';
    const DRIFT_URL_2 = '/api/v1/sources/source-2/class-drift';

    let resolveOne: (res: Response) => void;
    const pendingOne = new Promise<Response>((resolve) => {
      resolveOne = resolve;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL) return pendingOne;
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      if (url === GET_URL_2 && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...sourceTwo, owner: 'Updated Owner' }));
      }
      if (url === GET_URL_2) return Promise.resolve(jsonResponse(sourceTwo));
      if (url === DRIFT_URL_2) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources/source-1']}>
        <Link to="/sources/source-2">Go to second source</Link>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading source…')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Go to second source'));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Source Two' }),
    ).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Owner Two')).toBeInTheDocument();

    // source-1's request finally settles after navigation moved on to source-2 — its `id`-keyed
    // effect was already cleaned up, so this must not overwrite the rendered heading or seed the
    // inventory form with source-1's values.
    resolveOne!(jsonResponse(sourceOne));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole('heading', { level: 1, name: 'Source One' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Source Two' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Owner Two')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save inventory details' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
    });
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall?.[0]).toBe(GET_URL_2);
  });

  it('drops a deferred inventory-save response for the previous source after navigating to a new one', async () => {
    const sourceOne = {
      ...sourceWithFileStates,
      id: 'source-1',
      name: 'Source One',
      owner: 'Owner One',
    };
    const sourceTwo = {
      ...sourceWithFileStates,
      id: 'source-2',
      name: 'Source Two',
      owner: 'Owner Two',
    };
    const GET_URL_2 = '/api/v1/sources/source-2';
    const DRIFT_URL_2 = '/api/v1/sources/source-2/class-drift';

    let resolvePatch: (res: Response) => void;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });

    const patchTargets: string[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL && init?.method === 'PATCH') {
        patchTargets.push(url);
        return pendingPatch;
      }
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceOne));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      if (url === GET_URL_2 && init?.method === 'PATCH') {
        patchTargets.push(url);
        return Promise.resolve(jsonResponse(sourceTwo));
      }
      if (url === GET_URL_2) return Promise.resolve(jsonResponse(sourceTwo));
      // Source Two carries its own drift so the stale success below has a dialog and a count to
      // leave untouched, not just an absent card.
      if (url === DRIFT_URL_2) {
        return Promise.resolve(jsonResponse({ previousClass: 'memo', count: 2 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources/source-1']}>
        <Link to="/sources/source-2">Go to second source</Link>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByDisplayValue('Owner One')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'Renamed One' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save inventory details' }));

    fireEvent.click(screen.getByText('Go to second source'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Source Two' }),
    ).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Owner Two')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Apply current class to 2 documents' }),
    ).toBeInTheDocument();

    // source-1's save finally answers after navigation moved on to source-2 — it must not merge
    // its stale result into the rendered source, reseed the form with source-1's values, toast
    // over source-2, or touch source-2's drift dialog.
    resolvePatch!(jsonResponse({ ...sourceOne, owner: 'Renamed One' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Source Two' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Owner Two')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Renamed One')).not.toBeInTheDocument();
    expect(getToasts()).not.toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Updated inventory details.' }),
    );
    expect(
      screen.getByRole('button', { name: 'Apply current class to 2 documents' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save inventory details' }));
    await waitFor(() => {
      expect(patchTargets).toContain(GET_URL_2);
    });
    expect(patchTargets[patchTargets.length - 1]).toBe(GET_URL_2);
  });

  it('drops a deferred rejected inventory-save response for the previous source after navigating to a new one', async () => {
    const sourceOne = {
      ...sourceWithFileStates,
      id: 'source-1',
      name: 'Source One',
      owner: 'Owner One',
    };
    const sourceTwo = {
      ...sourceWithFileStates,
      id: 'source-2',
      name: 'Source Two',
      owner: 'Owner Two',
    };
    const GET_URL_2 = '/api/v1/sources/source-2';
    const DRIFT_URL_2 = '/api/v1/sources/source-2/class-drift';

    let resolvePatch: (res: Response) => void;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL && init?.method === 'PATCH') return pendingPatch;
      if (url === GET_URL) return Promise.resolve(jsonResponse(sourceOne));
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      if (url === GET_URL_2) return Promise.resolve(jsonResponse(sourceTwo));
      // Source Two carries its own drift so a stale rejection has a dialog and a count to leave
      // untouched, not just an absent card.
      if (url === DRIFT_URL_2) {
        return Promise.resolve(jsonResponse({ previousClass: 'memo', count: 2 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources/source-1']}>
        <Link to="/sources/source-2">Go to second source</Link>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByDisplayValue('Owner One')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save inventory details' }));

    fireEvent.click(screen.getByText('Go to second source'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Source Two' }),
    ).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Owner Two')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Apply current class to 2 documents' }),
    ).toBeInTheDocument();
    const focusBeforeReject = document.activeElement;

    // source-1's save finally rejects after navigation moved on to source-2 — the rejection must
    // not render as source-2's form error, move focus into source-2's form, or touch source-2's
    // drift dialog.
    resolvePatch!(jsonResponse({ message: 'Failed to update inventory' }, 500));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Source Two' })).toBeInTheDocument();
    expect(screen.queryByText('Failed to update inventory')).not.toBeInTheDocument();
    expect(document.querySelector('.error-summary')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(focusBeforeReject);
    expect(getToasts()).toEqual([]);
    expect(
      screen.getByRole('button', { name: 'Apply current class to 2 documents' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('drops a deferred reloadAfterSync response for the previous source after navigating to a new one', async () => {
    const sourceOne = {
      ...sourceWithFileStates,
      id: 'source-1',
      name: 'Source One',
      owner: 'Owner One',
    };
    const sourceTwo = {
      ...sourceWithFileStates,
      id: 'source-2',
      name: 'Source Two',
      owner: 'Owner Two',
    };
    const GET_URL_2 = '/api/v1/sources/source-2';
    const DRIFT_URL_2 = '/api/v1/sources/source-2/class-drift';

    let sourceCall = 0;
    let resolveReload: (res: Response) => void;
    const pendingReload = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === ME_URL) return Promise.resolve(jsonResponse(admin));
      if (url === GET_URL) {
        sourceCall += 1;
        if (sourceCall <= 2) return Promise.resolve(jsonResponse(sourceOne));
        if (sourceCall === 3) {
          return Promise.resolve(
            jsonResponse({
              ...sourceOne,
              lastSyncAt: new Date().toISOString(),
              lastSyncStatus: 'ok',
            }),
          );
        }
        // The fourth call is reloadAfterSync's own fetch, triggered once the sweep above settles.
        return pendingReload;
      }
      if (url === DRIFT_URL) return Promise.resolve(jsonResponse({ count: 0 }));
      if (url === '/api/v1/sources/source-1/sync') {
        return Promise.resolve(
          jsonResponse(
            {
              id: 'run-1',
              workflowId: 'wf-1',
              status: 'completed',
              createdAt: new Date().toISOString(),
            },
            201,
          ),
        );
      }
      if (url === GET_URL_2) return Promise.resolve(jsonResponse(sourceTwo));
      if (url === DRIFT_URL_2) return Promise.resolve(jsonResponse({ count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources/source-1']}>
        <Link to="/sources/source-2">Go to second source</Link>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage pollIntervalMs={5} />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Source One' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => expect(sourceCall).toBeGreaterThanOrEqual(4));

    fireEvent.click(screen.getByText('Go to second source'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Source Two' }),
    ).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Owner Two')).toBeInTheDocument();

    // reloadAfterSync's own fetch for source-1 answers after navigation moved on to source-2 — it
    // must not overwrite source-2's heading or reseed its form with source-1's values.
    resolveReload!(jsonResponse({ ...sourceOne, owner: 'Reloaded One' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Source Two' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Owner Two')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Reloaded One')).not.toBeInTheDocument();
  });

  it('exposes a file path without hovering', async () => {
    stubFetch({
      [GET_URL]: () => jsonResponse(sourceWithFileStates),
      [DRIFT_URL]: () => jsonResponse({ count: 0 }),
    });

    renderAt('source-1');

    const path = await screen.findByText('contracts/lease-agreement.pdf');
    expect(screen.getAllByRole('button', { name: 'Copy path' })).toHaveLength(2);
    // The truncated path and its CopyButton share a `.cell-truncate-action` row so the flex layout
    // keeps them on one line instead of the tooltip anchor's own `display: block` forcing a break.
    const row = path.closest('.cell-truncate-action');
    expect(row).not.toBeNull();
    expect(row).toContainElement(screen.getAllByRole('button', { name: 'Copy path' })[0]);
    // Truncated in its cell, and the Copy path button beside it copies without showing the text, so
    // keyboard focus on the path itself opens the full path.
    expect(path).toHaveAttribute('tabindex', '0');
    path.focus();
    const pathTooltip = await screen.findByRole('tooltip');
    expect(pathTooltip).toHaveTextContent('contracts/lease-agreement.pdf');
    expect(path).toHaveAttribute('aria-describedby', pathTooltip.id);

    const table = screen.getByRole('table', { name: 'Per-file sync status for this source' });
    const cols = table.querySelectorAll('col');
    expect(cols).toHaveLength(4);
    expect(cols[0]).not.toHaveAttribute('class');
    // Widened from `col-narrow` so "LAST MODIFIED" (13 uppercase, tracked glyphs) does not run
    // into the sticky header cell beside it.
    expect(cols[3]).toHaveClass('col-compact');
    expect(table).toHaveClass('source-detail-grid');
  });
});
