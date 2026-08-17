import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import DataRoomPage from './DataRoomPage';

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
    createdAt: new Date().toISOString(),
  },
  versions: [
    {
      id: 'v-1',
      versionNumber: 1,
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      ingestionStatus: 'completed',
      createdAt: new Date().toISOString(),
    },
  ],
};

const chunks = {
  docs: [
    {
      id: 'chunk-1',
      text: 'Net operating income for Q3 was $1.2M.',
      tokenCount: 12,
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Summary', cell: 'B4' },
    },
  ],
  count: 1,
};

// Dispatches by URL and method so a test can mock only the endpoints it cares about, matching
// ApprovalsPage.test.tsx's stubFetch shape.
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

describe('DataRoomPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
  });

  it('lists documents with their ingestion status, and the parser reason behind a failed one', async () => {
    const documents = {
      docs: [
        {
          id: 'doc-1',
          title: 'Q3 Rent Roll',
          sourceKind: 'xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          currentVersion: {
            id: 'v-1',
            versionNumber: 1,
            sha256: 'a'.repeat(64),
            sizeBytes: 100,
            ingestionStatus: 'completed',
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
        {
          id: 'doc-2',
          title: 'Valuation Memo',
          sourceKind: 'pdf',
          mimeType: 'application/pdf',
          currentVersion: {
            id: 'v-2',
            versionNumber: 1,
            sha256: 'b'.repeat(64),
            sizeBytes: 200,
            ingestionStatus: 'pending',
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
        {
          id: 'doc-3',
          title: 'Broken Scan',
          sourceKind: 'pdf',
          mimeType: 'application/pdf',
          currentVersion: {
            id: 'v-3',
            versionNumber: 1,
            sha256: 'c'.repeat(64),
            sizeBytes: 300,
            ingestionStatus: 'failed',
            ingestionFailureReason: 'PDF parse failed: no extractable text layer',
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
      ],
      count: 3,
    };

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(documents));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <DataRoomPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
    expect(screen.getByText('Valuation Memo')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    // A failed row that shows only the word "failed" throws away the one thing the API knows
    // about the failure.
    expect(screen.getByText('PDF parse failed: no extractable text layer')).toBeInTheDocument();
  });

  it('shows a loading state before the document list arrives', async () => {
    let resolveList: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <DataRoomPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    resolveList!(jsonResponse({ docs: [], count: 0 }));

    expect(await screen.findByText('No documents yet.')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('renders the load error above the table, not below', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Documents unavailable' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <DataRoomPage />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole('alert');
    const table = screen.getByRole('table');

    expect(alert.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uploads each selected file separately, one client call per file', async () => {
    const uploaded = {
      id: 'doc-3',
      title: 'Batch',
      sourceKind: 'pdf',
      mimeType: 'application/pdf',
      currentVersion: {
        id: 'v-3',
        versionNumber: 1,
        sha256: 'c'.repeat(64),
        sizeBytes: 50,
        ingestionStatus: 'pending',
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    };

    // Branches on method rather than a fixed call sequence: the initial GET, the follow-up GET
    // that fires after upload (refreshToken bump), and each upload POST all need distinct shapes.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse(uploaded));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <DataRoomPage />
      </MemoryRouter>,
    );

    await screen.findByText('No documents yet.');

    const files = [
      new File(['a'], 'rent-roll.pdf', { type: 'application/pdf' }),
      new File(['b'], 'memo.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      new File(['c'], 'valuation.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ];

    fireEvent.change(screen.getByLabelText('File', { exact: false }), { target: { files } });
    // fireEvent.submit bypasses the browser's native required-file constraint check, which a
    // programmatic `files` override does not satisfy (jsdom still sees `.value` as empty).
    const form = screen.getByRole('button', { name: 'Upload' }).closest('form');
    if (!form) throw new Error('Upload form not found');
    fireEvent.submit(form);

    await waitFor(() => {
      const uploadCalls = fetchMock.mock.calls.filter(
        ([, init]) => init?.method === 'POST' && init.body instanceof FormData,
      );
      expect(uploadCalls).toHaveLength(files.length);
      for (const [i, file] of files.entries()) {
        const body = uploadCalls[i][1]?.body;
        if (!(body instanceof FormData)) throw new Error('Upload body was not FormData');
        expect(body.get('title')).toBe(file.name);
      }
    });
  });

  it('shows a chunks drill-in and a download link for each version', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/documents/doc-1': () => jsonResponse(documentDetail),
      '/api/v1/documents/versions/v-1/chunks': () => jsonResponse(chunks),
    });

    renderDetail();

    expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();

    const downloadLink = screen.getByRole('link', { name: 'Download' });
    expect(downloadLink).toHaveAttribute('href', '/api/v1/documents/versions/v-1/content');

    fireEvent.click(screen.getByRole('button', { name: 'View chunks' }));

    expect(await screen.findByText('Net operating income for Q3 was $1.2M.')).toBeInTheDocument();
    expect(screen.getByText('xlsx-cell · 12 tokens')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide chunks' }));
    expect(screen.queryByText('Net operating income for Q3 was $1.2M.')).not.toBeInTheDocument();
  });

  it('an admin deletes a document after confirming, then returns to the list', async () => {
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

    fireEvent.click(await screen.findByRole('button', { name: 'Delete document' }));

    expect(screen.getByText('Delete this document permanently?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete document' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByText('document list probe')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === '/api/v1/documents/doc-1' && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('arming the delete moves focus to the confirm button and announces the prompt', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/documents/doc-1': () => jsonResponse(documentDetail),
    });

    renderDetail();

    const arm = await screen.findByRole('button', { name: 'Delete document' });
    // Rendering the page never grabs focus — only leaving the confirm hands it back.
    expect(arm).not.toHaveFocus();

    fireEvent.click(arm);

    const confirm = screen.getByRole('button', { name: 'Confirm delete' });
    expect(confirm).toHaveFocus();
    expect(screen.getByRole('alert')).toContainElement(confirm);
  });

  it('cancelling the delete confirmation returns to the un-armed state without deleting', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === '/api/v1/documents/doc-1') return Promise.resolve(jsonResponse(documentDetail));
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete document' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete this document permanently?')).not.toBeInTheDocument();
    const arm = await screen.findByRole('button', { name: 'Delete document' });
    expect(arm).toBeInTheDocument();
    // Backing out of the flow puts the keyboard user back where they started, rather than on
    // <body> with the arming button unmounted from under them.
    expect(arm).toHaveFocus();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('a member sees why deleting is unavailable, and cannot reach the delete controls', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
      '/api/v1/documents/doc-1': () => jsonResponse(documentDetail),
    });

    renderDetail();

    expect(await screen.findByText('Deleting evidence requires an admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete document' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Delete document' })).not.toBeInTheDocument();

    resolveMe!(jsonResponse(admin));

    expect(await screen.findByRole('button', { name: 'Delete document' })).toBeInTheDocument();
    expect(screen.queryByText('Deleting evidence requires an admin.')).not.toBeInTheDocument();
  });

  it('shows the parser reason on a failed version row', async () => {
    const failedDetail = {
      ...documentDetail,
      versions: [
        {
          ...documentDetail.versions[0],
          ingestionStatus: 'failed',
          ingestionFailureReason: 'DOCX parse failed: unsupported OOXML part',
        },
      ],
    };

    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/documents/doc-1': () => jsonResponse(failedDetail),
    });

    renderDetail();

    expect(
      await screen.findByText('DOCX parse failed: unsupported OOXML part'),
    ).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });
});
