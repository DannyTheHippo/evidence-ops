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
      // sizeBytes and mimeType are on the wire; a raw byte count would tell a reader nothing.
      expect(screen.getByText('100 B')).toBeInTheDocument();
      expect(
        screen.getByText('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      ).toBeInTheDocument();
      expect(screen.getAllByText('application/pdf')).toHaveLength(2);
      // The row is reachable as a real link, not just a click handler on the <tr>.
      expect(screen.getByRole('link', { name: 'Q3 Rent Roll' })).toHaveAttribute(
        'href',
        '/documents/doc-1',
      );
    });

    it('shows the pager total and disables Previous on the first page when the list is truncated', async () => {
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

      expect(await screen.findByText('25 total')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });

    it('pages past the first 20 documents with skip/limit, and back again', async () => {
      const pageOf = (id: string, count: number) => ({
        docs: [
          {
            id,
            title: id,
            sourceKind: 'pdf',
            mimeType: 'application/pdf',
            currentVersion: {
              id: `${id}-v1`,
              versionNumber: 1,
              sha256: 'a'.repeat(64),
              sizeBytes: 100,
              ingestionStatus: 'completed',
              createdAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
          },
        ],
        count,
      });

      const fetchMock = vi.fn((url: string) => {
        if (url === '/api/v1/documents?skip=20&limit=20') {
          return Promise.resolve(jsonResponse(pageOf('doc-page-2', 25)));
        }
        return Promise.resolve(jsonResponse(pageOf('doc-page-1', 25)));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      expect(await screen.findByText('doc-page-1')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Next' }));

      expect(await screen.findByText('doc-page-2')).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(
          ([calledUrl]) => calledUrl === '/api/v1/documents?skip=20&limit=20',
        ),
      ).toBe(true);
      expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Previous' }));

      expect(await screen.findByText('doc-page-1')).toBeInTheDocument();
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

    it('guards against a double submit between the click and the button becoming disabled', async () => {
      const uploaded = {
        id: 'doc-5',
        title: 'Rent Roll',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-5',
          versionNumber: 1,
          sha256: 'e'.repeat(64),
          sizeBytes: 50,
          ingestionStatus: 'pending',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };

      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(jsonResponse(uploaded));
        }
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('No documents yet');

      fireEvent.change(screen.getByLabelText('File', { exact: false }), {
        target: { files: [new File(['a'], 'rent-roll.pdf', { type: 'application/pdf' })] },
      });
      const form = screen.getByRole('button', { name: 'Upload' }).closest('form');
      if (!form) throw new Error('Upload form not found');
      fireEvent.submit(form);
      fireEvent.submit(form);

      await waitFor(() => {
        const uploadCalls = fetchMock.mock.calls.filter(
          ([, init]) => init?.method === 'POST' && init.body instanceof FormData,
        );
        expect(uploadCalls).toHaveLength(1);
      });
    });

    it('offers the declarable source classes but never unclassified, and threads the chosen one into the upload', async () => {
      const uploaded = {
        id: 'doc-4',
        title: 'Classified',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        sourceClass: 'memo',
        currentVersion: {
          id: 'v-4',
          versionNumber: 1,
          sha256: 'd'.repeat(64),
          sizeBytes: 50,
          ingestionStatus: 'pending',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };

      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(jsonResponse(uploaded));
        }
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('No documents yet');

      const select = screen.getByLabelText('Source class');
      const optionLabels = screen
        .getAllByRole('option')
        .filter((option) => option.closest('select') === select)
        .map((option) => option.textContent);
      expect(optionLabels).not.toContain('Unclassified');
      expect(optionLabels).toContain('Memo');

      fireEvent.change(select, { target: { value: 'memo' } });
      fireEvent.change(screen.getByLabelText('File', { exact: false }), {
        target: { files: [new File(['a'], 'memo.pdf', { type: 'application/pdf' })] },
      });
      const form = screen.getByRole('button', { name: 'Upload' }).closest('form');
      if (!form) throw new Error('Upload form not found');
      fireEvent.submit(form);

      await waitFor(() => {
        const uploadCall = fetchMock.mock.calls.find(
          ([, init]) => init?.method === 'POST' && init.body instanceof FormData,
        );
        if (!uploadCall) throw new Error('No upload call found');
        const body = uploadCall[1]?.body;
        if (!(body instanceof FormData)) throw new Error('Upload body was not FormData');
        expect(body.get('sourceClass')).toBe('memo');
      });
    });

    it('shows a filter-specific empty state when the ingestion status filter matches nothing', async () => {
      const completedDoc = {
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
      };

      const fetchMock = vi.fn((url: string) => {
        if (url === '/api/v1/documents?skip=0&limit=20') {
          return Promise.resolve(jsonResponse({ docs: [completedDoc], count: 1 }));
        }
        if (url === '/api/v1/documents?skip=0&limit=20&ingestionStatus=needs-ocr') {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('Q3 Rent Roll');

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'needs-ocr' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

      expect(await screen.findByText('No documents match this filter')).toBeInTheDocument();
      expect(screen.queryByText('Q3 Rent Roll')).not.toBeInTheDocument();
    });

    it('applies the ingestion status filter as a server-side query parameter and resets to page 1', async () => {
      const needsOcrDoc = {
        id: 'doc-2',
        title: 'Scanned Rent Roll',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-2',
          versionNumber: 1,
          sha256: 'b'.repeat(64),
          sizeBytes: 200,
          ingestionStatus: 'needs-ocr',
          ingestionFailureReason:
            'Document has 3 page(s) but no extractable text on any of them ' +
            '(likely a scanned image with no embedded text layer); OCR is out of scope for this parser',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };
      const pageOneDoc = {
        id: 'doc-page-1',
        title: 'Page One Doc',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-page-1',
          versionNumber: 1,
          sha256: 'c'.repeat(64),
          sizeBytes: 100,
          ingestionStatus: 'completed',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };

      const fetchMock = vi.fn((url: string) => {
        if (url === '/api/v1/documents?skip=0&limit=20') {
          return Promise.resolve(jsonResponse({ docs: [pageOneDoc], count: 25 }));
        }
        if (url === '/api/v1/documents?skip=20&limit=20') {
          return Promise.resolve(jsonResponse({ docs: [pageOneDoc], count: 25 }));
        }
        if (url === '/api/v1/documents?skip=0&limit=20&ingestionStatus=needs-ocr') {
          return Promise.resolve(jsonResponse({ docs: [needsOcrDoc], count: 1 }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('Page One Doc');

      // Move off page 1 first, so applying the filter can prove it resets `skip` rather than
      // filtering whatever page happened to be open.
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await vi.waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([calledUrl]) => calledUrl === '/api/v1/documents?skip=20&limit=20',
          ),
        ).toBe(true),
      );

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'needs-ocr' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

      expect(await screen.findByText('Scanned Rent Roll')).toBeInTheDocument();
      expect(screen.getByText('needs-ocr')).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(
          ([calledUrl]) =>
            calledUrl === '/api/v1/documents?skip=0&limit=20&ingestionStatus=needs-ocr',
        ),
      ).toBe(true);
    });

    it('offers facts-failed as its own filter and badges it as a caution, not a rejection', async () => {
      const factsFailedDoc = {
        id: 'doc-3',
        title: 'Northgate Rent Roll',
        sourceKind: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        currentVersion: {
          id: 'v-3',
          versionNumber: 1,
          sha256: 'd'.repeat(64),
          sizeBytes: 300,
          ingestionStatus: 'facts-failed',
          ingestionFailureReason: 'Fact extraction failed: model returned no parseable output',
          reducedFidelityReasons: [],
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };

      const fetchMock = vi.fn((url: string) => {
        if (url === '/api/v1/documents?skip=0&limit=20') {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        if (url === '/api/v1/documents?skip=0&limit=20&ingestionStatus=facts-failed') {
          return Promise.resolve(jsonResponse({ docs: [factsFailedDoc], count: 1 }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('No documents yet');

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'facts-failed' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

      expect(await screen.findByText('Northgate Rent Roll')).toBeInTheDocument();
      // Its chunks are committed and citable — a caution, not the rejection tone a failed
      // ingestion carries.
      expect(screen.getByText('facts-failed').className).toContain('badge--possible');
      expect(
        screen.getByText('Fact extraction failed: model returned no parseable output'),
      ).toBeInTheDocument();
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

    it('opens a fresh stream scoped to the new page when paging past page 1, closing the old one', async () => {
      renderList();

      const [firstPageSource] = FakeEventSource.instances;
      expect(firstPageSource.url).toBe('/api/v1/documents/events?skip=0&limit=20');
      act(() => {
        firstPageSource.emit('documents', {
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
        });
      });
      await screen.findByText('Q3 Rent Roll');
      expect(firstPageSource.closed).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Next' }));

      // Paging changes the stream URL (`skip=20`), which re-triggers `useEventStream`'s connection
      // effect: the page-1 socket closes and a fresh one opens scoped to the new page — the stream
      // stays live on every page now, not only the first.
      expect(firstPageSource.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(2);
      const [, secondPageSource] = FakeEventSource.instances;
      expect(secondPageSource.url).toBe('/api/v1/documents/events?skip=20&limit=20');
      expect(secondPageSource.closed).toBe(false);

      act(() => {
        secondPageSource.emit('documents', {
          docs: [
            {
              id: 'doc-2',
              title: 'Page Two Doc',
              sourceKind: 'pdf',
              mimeType: 'application/pdf',
              currentVersion: {
                id: 'v-2',
                versionNumber: 1,
                sha256: 'b'.repeat(64),
                sizeBytes: 200,
                ingestionStatus: 'completed',
                createdAt: new Date().toISOString(),
              },
              createdAt: new Date().toISOString(),
            },
          ],
          count: 25,
        });
      });

      expect(await screen.findByText('Page Two Doc')).toBeInTheDocument();
    });
  });
});
