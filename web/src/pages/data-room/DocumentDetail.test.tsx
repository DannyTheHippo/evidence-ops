import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../../lib/auth';
import { clearToasts, getToasts } from '../../components/ui/toast';
import DataRoomPage from '../DataRoomPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

const documentDetail = {
  id: 'doc-1',
  title: 'Q3 Rent Roll',
  sourceKind: 'xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  createdAt: new Date().toISOString(),
  currentVersion: {
    id: 'v-1',
    versionNumber: 1,
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    ingestionStatus: 'completed',
    reducedFidelityReasons: [],
    createdAt: new Date().toISOString(),
  },
  versions: [
    {
      id: 'v-1',
      versionNumber: 1,
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      ingestionStatus: 'completed',
      reducedFidelityReasons: [],
      createdAt: new Date().toISOString(),
    },
  ],
};

// Dispatches by URL and method so a test can mock only the endpoints it cares about, matching
// ApiKeysPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderDetail(id = 'doc-1') {
  render(
    <MemoryRouter initialEntries={[`/documents/${id}`]}>
      <Routes>
        <Route path="/documents/:id" element={<DataRoomPage />} />
        <Route path="/documents" element={<p>document list probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DocumentDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
    clearToasts();
  });

  it('shows the document title, its versions and a download link', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/documents/doc-1': () => jsonResponse(documentDetail),
    });

    renderDetail();

    expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
    const downloadLink = screen.getByRole('link', { name: 'Download' });
    expect(downloadLink).toHaveAttribute('href', '/api/v1/documents/versions/v-1/content');
    // sizeBytes and mimeType are on the wire; a raw byte count would tell a reader nothing.
    expect(screen.getByText('100 B')).toBeInTheDocument();
    expect(
      screen.getByText('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Versions of Q3 Rent Roll' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    // The description list's own current-version summary, distinct from the version table's
    // own "v1"/"completed" cell for the same version.
    expect(screen.getByText('xlsx')).toBeInTheDocument();
    expect(screen.getByText('Deleting a document cannot be undone.')).toBeInTheDocument();
  });

  it('shows a calm not-found notice for a missing or already-deleted document', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/documents/doc-1': () => jsonResponse({ message: 'Document not found' }, 404),
    });

    renderDetail();

    expect(await screen.findByText('Document not found.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the load error instead of the version table', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/documents/doc-1': () => jsonResponse({ message: 'Document unavailable' }, 500),
    });

    renderDetail();

    expect(await screen.findByRole('alert')).toHaveTextContent('Document unavailable');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('an admin deletes a document after confirming in the dialog, then returns to the list', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === '/api/v1/documents/doc-1' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === '/api/v1/documents/doc-1') return Promise.resolve(jsonResponse(documentDetail));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('dialog', { name: 'Delete "Q3 Rent Roll"?' });
    expect(dialog).toHaveTextContent(
      "Deleting cascades to all of this document's versions, chunks, extracted facts and stored bytes.",
    );
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete document' }));

    expect(await screen.findByText('document list probe')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === '/api/v1/documents/doc-1' && init?.method === 'DELETE',
      ),
    ).toBe(true);
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Deleted "Q3 Rent Roll".' }),
    );
  });

  it('opens the destructive delete dialog focused on Cancel, not Delete document', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/documents/doc-1': () => jsonResponse(documentDetail),
    });

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete document' })).not.toHaveFocus();
  });

  it('cancelling the delete dialog closes it without deleting', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === '/api/v1/documents/doc-1') return Promise.resolve(jsonResponse(documentDetail));
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('a member sees why deleting is unavailable, and cannot reach the delete controls', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
      '/api/v1/documents/doc-1': () => jsonResponse(documentDetail),
    });

    renderDetail();

    expect(await screen.findByText('Deleting evidence requires an admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('withholds the admin-only notice until the session probe resolves, then admits the admin', async () => {
    let resolveMe: (res: Response) => void;
    const pendingMe = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return pendingMe;
      if (url === '/api/v1/documents/doc-1') return Promise.resolve(jsonResponse(documentDetail));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    // Anchored on the document itself, so the two absences below are about the unresolved
    // session rather than a page that has not rendered yet.
    expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
    expect(screen.queryByText('Deleting evidence requires an admin.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    resolveMe!(jsonResponse(admin));

    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByText('Deleting evidence requires an admin.')).not.toBeInTheDocument();
  });
});
