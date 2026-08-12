import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DataRoomPage from './DataRoomPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DataRoomPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists documents with their ingestion status, distinguishing pending from completed', async () => {
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
      ],
      count: 2,
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
    });
  });
});
