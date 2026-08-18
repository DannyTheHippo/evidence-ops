import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, getToasts } from '../../components/ui/toast';
import { FakeEventSource } from '../../test/fake-event-source';
import DocumentList from './DocumentList';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderList() {
  render(
    <MemoryRouter>
      <DocumentList />
    </MemoryRouter>,
  );
}

describe('DocumentList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearToasts();
  });

  describe('without a live stream (fallback to fetch)', () => {
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

      renderList();

      expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
      expect(screen.getByText('Valuation Memo')).toBeInTheDocument();
      expect(screen.getByText('completed')).toBeInTheDocument();
      expect(screen.getByText('pending')).toBeInTheDocument();
      expect(screen.getByText('failed')).toBeInTheDocument();
      // A failed row that shows only the word "failed" throws away the one thing the API knows
      // about the failure.
      expect(screen.getByText('PDF parse failed: no extractable text layer')).toBeInTheDocument();
    });

    it('shows how many documents are visible against the total when the list is truncated', async () => {
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
        ],
        count: 25,
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(documents));
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      expect(await screen.findByText('Showing 1 of 25.')).toBeInTheDocument();
    });

    it('shows a loading state before the document list arrives', async () => {
      let resolveList: (res: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveList = resolve;
      });
      const fetchMock = vi.fn().mockReturnValue(pending);
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      expect(screen.getByText('Loading documents…')).toBeInTheDocument();

      resolveList!(jsonResponse({ docs: [], count: 0 }));

      expect(await screen.findByText('No documents yet')).toBeInTheDocument();
      expect(screen.queryByText('Loading documents…')).not.toBeInTheDocument();
    });

    it('shows the load error instead of the table', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ message: 'Documents unavailable' }, 500));
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      expect(await screen.findByRole('alert')).toHaveTextContent('Documents unavailable');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('uploads each selected file separately, one client call per file, and notifies on completion', async () => {
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
      // that fires after upload, and each upload POST all need distinct shapes.
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(jsonResponse(uploaded));
        }
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      await screen.findByText('No documents yet');

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

      await waitFor(() => {
        expect(getToasts()).toContainEqual(
          expect.objectContaining({ kind: 'success', message: 'Uploaded 3 files.' }),
        );
      });
    });

    it('keeps polling while any version is pending, and stops once none is', async () => {
      vi.useFakeTimers();
      const pendingDoc = {
        id: 'doc-1',
        title: 'Q3 Rent Roll',
        sourceKind: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        currentVersion: {
          id: 'v-1',
          versionNumber: 1,
          sha256: 'a'.repeat(64),
          sizeBytes: 100,
          ingestionStatus: 'pending',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };
      const completedDoc = {
        ...pendingDoc,
        currentVersion: { ...pendingDoc.currentVersion, ingestionStatus: 'completed' },
      };

      let call = 0;
      const fetchMock = vi.fn(() => {
        call += 1;
        return Promise.resolve(
          jsonResponse({ docs: [call === 1 ? pendingDoc : completedDoc], count: 1 }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      await vi.waitFor(() => expect(screen.getByText('pending')).toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // Ingestion resolved on the previous tick — the interval must not fire again.
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('with a live stream', () => {
    beforeEach(() => {
      FakeEventSource.reset();
      vi.stubGlobal('EventSource', FakeEventSource);
    });

    it('renders the list pushed by a documents event', async () => {
      renderList();

      const [source] = FakeEventSource.instances;
      act(() => {
        source.emit('documents', {
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
          ],
          count: 1,
        });
      });

      expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
    });

    it('does not treat a heartbeat frame as a document list', async () => {
      renderList();

      const [source] = FakeEventSource.instances;
      act(() => {
        source.emit('documents', {
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
          ],
          count: 1,
        });
      });
      await screen.findByText('Q3 Rent Roll');

      act(() => {
        source.emit('heartbeat', {});
      });

      expect(screen.getByText('Q3 Rent Roll')).toBeInTheDocument();
    });
  });
});
