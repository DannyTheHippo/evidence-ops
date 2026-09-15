import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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

function renderList(initialEntry = '/') {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <DocumentList />
    </MemoryRouter>,
  );
}

// Every ingestion label the table shows is also an option in the status filter above it, so a
// badge assertion has to be scoped to the table to name one row rather than two elements.
function inTable() {
  return within(screen.getByRole('table'));
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
            sourceClass: 'crm-export',
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
      expect(inTable().getByText('Completed')).toBeInTheDocument();
      expect(inTable().getByText('Pending')).toBeInTheDocument();
      expect(inTable().getByText('Failed')).toBeInTheDocument();
      // A failed row that shows only the word "failed" throws away the one thing the API knows
      // about the failure.
      const reason = screen.getByText('PDF parse failed: no extractable text layer');
      // Truncated in the cell, so keyboard focus on it opens the full reason.
      expect(reason).toHaveAttribute('tabindex', '0');
      reason.focus();
      const reasonTooltip = await screen.findByRole('tooltip');
      expect(reasonTooltip).toHaveTextContent('PDF parse failed: no extractable text layer');
      expect(reason).toHaveAttribute('aria-describedby', reasonTooltip.id);
      reason.blur();
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

      // sizeBytes and mimeType are on the wire; a raw byte count would tell a reader nothing.
      expect(screen.getByText('100 B')).toBeInTheDocument();
      const mimeType = screen.getByText(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(mimeType).toHaveAttribute('tabindex', '0');
      mimeType.focus();
      const mimeTooltip = await screen.findByRole('tooltip');
      expect(mimeTooltip).toHaveTextContent(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(mimeType).toHaveAttribute('aria-describedby', mimeTooltip.id);
      mimeType.blur();
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

      const sourceClass = inTable().getByText('CRM export');
      expect(sourceClass).toHaveAttribute('tabindex', '0');
      sourceClass.focus();
      const sourceClassTooltip = await screen.findByRole('tooltip');
      expect(sourceClassTooltip).toHaveTextContent('CRM export');
      expect(sourceClass).toHaveAttribute('aria-describedby', sourceClassTooltip.id);
      sourceClass.blur();
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

      expect(screen.getAllByText('application/pdf')).toHaveLength(2);
      // The row is reachable as a real link, not just a click handler on the <tr> — and it leads
      // straight into the workbench reader for the document's current version, not a metadata
      // page. The Tooltip wraps this RowLink directly, so keyboard focus on the link opens it and
      // the link itself carries the description.
      const titleLink = screen.getByRole('link', { name: 'Q3 Rent Roll' });
      expect(titleLink).toHaveAttribute('href', '/documents/doc-1/versions/v-1');
      titleLink.focus();
      const titleTooltip = await screen.findByRole('tooltip');
      expect(titleTooltip).toHaveTextContent('Q3 Rent Roll');
      expect(titleLink).toHaveAttribute('aria-describedby', titleTooltip.id);
      expect(
        screen.getByRole('region', {
          name: 'Documents uploaded to the data room, with their ingestion status',
        }),
      ).toHaveAttribute('tabindex', '0');
      // No EventSource is stubbed in this describe block, so the stream falls back to polling
      // immediately — the status line says so instead of silently claiming to be live.
      expect(screen.getByRole('status')).toHaveTextContent('3 documents · Polling');

      // The colgroup is what lets Title's `.cell-truncate` actually clip under a fixed table
      // layout: every other column states a width, and Title (the leading col) carries none.
      // Source and Actions are trimmed to `col-narrow`; Class, Version and Size go one step
      // narrower still, to `col-slim`, each value already truncating with a tooltip where it can
      // vary — so the `.documents-grid` floor leaves Title room without the table overflowing its
      // panel at 1440.
      const cols = screen.getByRole('table').querySelectorAll('col');
      expect(cols).toHaveLength(8);
      expect(cols[0]).not.toHaveAttribute('class');
      expect(cols[2]).toHaveClass('col-narrow');
      expect(cols[3]).toHaveClass('col-slim');
      expect(cols[4]).toHaveClass('col-slim');
      expect(cols[5]).toHaveClass('col-slim');
      expect(cols[7]).toHaveClass('col-narrow');
      expect(screen.getByRole('table')).toHaveClass('documents-grid');
    });

    it('shows the pager total and marks Previous aria-disabled on the first page when the list is truncated', async () => {
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
        count: 30,
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(documents));
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      expect(await screen.findByText('1–25 of 30')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute(
        'aria-disabled',
        'false',
      );
    });

    it('falls back to the default sort and direction for a hand-edited URL', async () => {
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
        count: 1,
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(documents));
      vi.stubGlobal('fetch', fetchMock);

      renderList('/?sort=bogus&sortDir=up');

      expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });

    it('pages past the first 25 documents with skip/limit, and back again', async () => {
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
        if (url === '/api/v1/documents?skip=25&limit=25&sort=createdAt&sortDir=desc') {
          return Promise.resolve(jsonResponse(pageOf('doc-page-2', 30)));
        }
        return Promise.resolve(jsonResponse(pageOf('doc-page-1', 30)));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      expect(await screen.findByText('doc-page-1')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Next' }));

      expect(await screen.findByText('doc-page-2')).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(
          ([calledUrl]) =>
            calledUrl === '/api/v1/documents?skip=25&limit=25&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
      expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
        'aria-disabled',
        'false',
      );
      expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');

      // Next is clickable but inert at the end — clicking it fires no further request.
      const fetchCallsAtEnd = fetchMock.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(fetchMock.mock.calls.length).toBe(fetchCallsAtEnd);

      fireEvent.click(screen.getByRole('button', { name: 'Previous' }));

      expect(await screen.findByText('doc-page-1')).toBeInTheDocument();
    });

    it('shows each document class and a Details link beside the row link into the reader', async () => {
      const documents = {
        docs: [
          {
            id: 'doc-1',
            title: 'Q3 Rent Roll',
            sourceKind: 'xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            sourceClass: 'memo',
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
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(documents));
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
      // The class the survivorship policy reads from, previously carried on the wire and shown
      // nowhere.
      expect(inTable().getByText('Memo')).toBeInTheDocument();
      // The row goes to the reader, so the document's own metadata page needs its own control —
      // named for its row, since every row's reads "Details".
      expect(screen.getByRole('link', { name: 'Q3 Rent Roll' })).toHaveAttribute(
        'href',
        '/documents/doc-1/versions/v-1',
      );
      expect(screen.getByRole('link', { name: 'Details, Q3 Rent Roll' })).toHaveAttribute(
        'href',
        '/documents/doc-1',
      );
    });

    it.each(['-5', 'abc'])('renders page 1 for a ?skip=%s the API would refuse', async (skip) => {
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
        count: 1,
      };
      const fetchMock = vi.fn((url: string) => {
        if (url === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=desc') {
          return Promise.resolve(jsonResponse(documents));
        }
        // A malformed value reaching the request unparsed is the defect: the API answers 400 and
        // the page shows an error instead of the first page.
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList(`/?skip=${skip}`);

      expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each(['?limit=7&skip=-1', '?limit=500'])(
      'requests the first 25 rows for %s, a page size the Pager does not offer',
      async (query) => {
        const fetchMock = vi.fn((url: string) => {
          if (url === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=desc') {
            return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
          }
          return Promise.reject(new Error(`Unhandled fetch: ${url}`));
        });
        vi.stubGlobal('fetch', fetchMock);

        renderList(`/${query}`);

        expect(await screen.findByText('No documents yet')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Rows per page')).toHaveValue('25');
      },
    );

    it('pages back to the last page that still has rows instead of stranding an empty one', async () => {
      const remainingDoc = {
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
        if (url === '/api/v1/documents?skip=25&limit=25&sort=createdAt&sortDir=desc') {
          return Promise.resolve(jsonResponse({ docs: [], count: 1 }));
        }
        return Promise.resolve(jsonResponse({ docs: [remainingDoc], count: 1 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList('/?skip=25');

      // "No documents yet" beside a pager reading "26–25 of 1" is what the page showed before the
      // rows behind page 2 were deleted.
      expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
      expect(screen.queryByText('No documents yet')).not.toBeInTheDocument();
      expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
    });

    it('resets the sort along with the filter when Clear is used', async () => {
      const doc = {
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
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [doc], count: 1 }));
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('Q3 Rent Roll');

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'completed' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Sort by Title' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([calledUrl]) =>
              calledUrl ===
              '/api/v1/documents?skip=0&limit=25&ingestionStatus=completed&sort=title&sortDir=desc',
          ),
        ).toBe(true),
      );

      const callsBeforeClear = fetchMock.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

      // Clear resets the sort as well as the filter, so a filtered, re-sorted view returns to the
      // default order — and to a live stream — in one action.
      await waitFor(() =>
        expect(
          fetchMock.mock.calls
            .slice(callsBeforeClear)
            .some(
              ([calledUrl]) =>
                calledUrl === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=desc',
            ),
        ).toBe(true),
      );
      expect(
        screen.getByRole('button', { name: 'Sort by Uploaded, sorted descending' }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Ingestion status')).toHaveValue('');
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

    it('accepts an .eml file end to end, alongside the other eight upload kinds', async () => {
      const uploaded = {
        id: 'doc-6',
        title: 'thread.eml',
        sourceKind: 'eml',
        mimeType: 'message/rfc822',
        currentVersion: {
          id: 'v-6',
          versionNumber: 1,
          sha256: 'f'.repeat(64),
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

      const fileInput = screen.getByLabelText('File', { exact: false });
      expect(fileInput).toHaveAttribute(
        'accept',
        '.pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.eml,.html,.htm',
      );

      fireEvent.change(fileInput, {
        target: { files: [new File(['a'], 'thread.eml', { type: 'message/rfc822' })] },
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
        expect(body.get('title')).toBe('thread.eml');
      });
    });

    it('keeps the entered title and source class after a failed upload instead of discarding them', async () => {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(jsonResponse({ message: 'Disk full' }, 500));
        }
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('No documents yet');

      fireEvent.change(screen.getByLabelText('Title', { exact: false }), {
        target: { value: 'Q3 Rent Roll' },
      });
      fireEvent.change(screen.getByLabelText('Source class'), { target: { value: 'memo' } });
      fireEvent.change(screen.getByLabelText('File', { exact: false }), {
        target: { files: [new File(['a'], 'rent-roll.pdf', { type: 'application/pdf' })] },
      });
      const form = screen.getByRole('button', { name: 'Upload' }).closest('form');
      if (!form) throw new Error('Upload form not found');
      fireEvent.submit(form);

      expect(await screen.findByText('Disk full')).toBeInTheDocument();
      // Discarding what was typed the moment the batch turns out to have failed would force a
      // retry to start from a blank form — the reset only runs once at least one file in the
      // batch has actually uploaded, never before the outcome is known.
      expect(screen.getByLabelText('Title', { exact: false })).toHaveValue('Q3 Rent Roll');
      expect(screen.getByLabelText('Source class')).toHaveValue('memo');
      expect(getToasts()).toHaveLength(0);
    });

    it('drops an oversize or wrong-type file into the drop zone as rejected, without blocking the rest of the batch', async () => {
      const uploaded = {
        id: 'doc-7',
        title: 'memo.pdf',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-7',
          versionNumber: 1,
          sha256: 'g'.repeat(64),
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

      const dropZone = screen.getByLabelText('File', { exact: false }).closest('label');
      if (!dropZone) throw new Error('Upload drop zone not found');

      const wrongTypeFile = new File(['a'], 'rogue.exe', { type: 'application/octet-stream' });
      const oversizeFile = new File([''], 'huge.pdf', { type: 'application/pdf' });
      Object.defineProperty(oversizeFile, 'size', { value: 60 * 1024 * 1024 });
      const goodFile = new File(['a'], 'memo.pdf', { type: 'application/pdf' });

      // `accept` is never consulted for a drop, so this client pre-check is the only thing
      // standing between either bad file and a doomed request.
      fireEvent.drop(dropZone, {
        dataTransfer: { files: [wrongTypeFile, oversizeFile, goodFile] },
      });

      expect(screen.getByText('rogue.exe')).toBeInTheDocument();
      expect(screen.getByText('Unsupported file type.')).toBeInTheDocument();
      expect(screen.getByText('huge.pdf')).toBeInTheDocument();
      expect(screen.getByText('File exceeds the 50 MB limit.')).toBeInTheDocument();
      expect(screen.getByText('memo.pdf')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

      const form = screen.getByRole('button', { name: 'Upload' }).closest('form');
      if (!form) throw new Error('Upload form not found');
      fireEvent.submit(form);

      await waitFor(() => {
        const uploadCalls = fetchMock.mock.calls.filter(
          ([, init]) => init?.method === 'POST' && init.body instanceof FormData,
        );
        expect(uploadCalls).toHaveLength(1);
      });
    });

    it('cancels the browser default for a file dragged over or dropped on the Title field beside the drop zone', async () => {
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ docs: [], count: 0 })),
      );
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('No documents yet');

      const titleInput = screen.getByLabelText('Title', { exact: false });
      const files = [new File(['a'], 'stray.pdf', { type: 'application/pdf' })];

      // An uncancelled file drop makes the browser navigate the tab to the file, discarding the
      // staged queue and the typed title.
      const dragOver = createEvent.dragOver(titleInput, {
        dataTransfer: { files, types: ['Files'] },
      });
      fireEvent(titleInput, dragOver);
      const drop = createEvent.drop(titleInput, { dataTransfer: { files, types: ['Files'] } });
      fireEvent(titleInput, drop);

      expect(dragOver.defaultPrevented).toBe(true);
      expect(drop.defaultPrevented).toBe(true);
    });

    it('cancels the browser default for a file dropped on the drop zone while an upload disables it, without staging the file', async () => {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Promise<Response>(() => {});
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

      expect(await screen.findByRole('button', { name: 'Uploading…' })).toBeDisabled();

      const dropZone = screen.getByLabelText('File', { exact: false }).closest('label');
      if (!dropZone) throw new Error('Upload drop zone not found');
      const files = [new File(['b'], 'late.pdf', { type: 'application/pdf' })];

      const dragOver = createEvent.dragOver(dropZone, {
        dataTransfer: { files, types: ['Files'] },
      });
      fireEvent(dropZone, dragOver);
      const drop = createEvent.drop(dropZone, { dataTransfer: { files, types: ['Files'] } });
      fireEvent(dropZone, drop);

      expect(dragOver.defaultPrevented).toBe(true);
      expect(drop.defaultPrevented).toBe(true);
      expect(screen.queryByText('late.pdf')).not.toBeInTheDocument();
    });

    it('leaves the browser default alone for a text drag, which carries no files, over or onto the Title field', async () => {
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ docs: [], count: 0 })),
      );
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('No documents yet');

      const titleInput = screen.getByLabelText('Title', { exact: false });

      // A drag that carries text, not a file, has no stray file to navigate the tab away — the
      // guard must leave it to the browser's native handling.
      const dragOver = createEvent.dragOver(titleInput, {
        dataTransfer: { types: ['text/plain'] },
      });
      fireEvent(titleInput, dragOver);
      const drop = createEvent.drop(titleInput, { dataTransfer: { types: ['text/plain'] } });
      fireEvent(titleInput, drop);

      expect(dragOver.defaultPrevented).toBe(false);
      expect(drop.defaultPrevented).toBe(false);
    });

    it('accepts a .htm file, which the old client accept list rejected, and it reaches a POST', async () => {
      const uploaded = {
        id: 'doc-8',
        title: 'filing.htm',
        sourceKind: 'html',
        mimeType: 'text/html',
        currentVersion: {
          id: 'v-8',
          versionNumber: 1,
          sha256: 'h'.repeat(64),
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
        target: { files: [new File(['a'], 'filing.htm', { type: 'text/html' })] },
      });

      expect(screen.queryByText('Unsupported file type.')).not.toBeInTheDocument();

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
        expect(body.get('title')).toBe('filing.htm');
      });
    });

    it('removes a staged file by name before submit, so it is never uploaded', async () => {
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ docs: [], count: 0 })),
      );
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('No documents yet');

      fireEvent.change(screen.getByLabelText('File', { exact: false }), {
        target: { files: [new File(['a'], 'rent-roll.pdf', { type: 'application/pdf' })] },
      });
      expect(screen.getByText('rent-roll.pdf')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Remove rent-roll.pdf' }));
      expect(screen.queryByText('rent-roll.pdf')).not.toBeInTheDocument();

      const form = screen.getByRole('button', { name: 'Upload' }).closest('form');
      if (!form) throw new Error('Upload form not found');
      fireEvent.submit(form);

      expect(
        await screen.findByRole('link', { name: 'Select at least one file to upload.' }),
      ).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('Clear finished empties the terminal rows from the batch record', async () => {
      const uploaded = {
        id: 'doc-9',
        title: 'memo.pdf',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-9',
          versionNumber: 1,
          sha256: 'i'.repeat(64),
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
        target: { files: [new File(['a'], 'memo.pdf', { type: 'application/pdf' })] },
      });
      const form = screen.getByRole('button', { name: 'Upload' }).closest('form');
      if (!form) throw new Error('Upload form not found');
      fireEvent.submit(form);

      expect(await screen.findByText('Uploaded')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));

      expect(screen.queryByText('Uploaded')).not.toBeInTheDocument();
      expect(screen.getByText('Files you add appear here.')).toBeInTheDocument();
    });

    // The named cause behind "the first Upload click does nothing" is refuted by reading
    // use-form-submit.ts: a blur-triggered re-render reconciles the same submit button, it does
    // not remount it. This is the click-driven measurement the report itself was missing — every
    // other upload test here submits the form directly.
    it('posts exactly one request per staged file on the first click, with no second click needed', async () => {
      const uploaded = {
        id: 'doc-10',
        title: 'a.pdf',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-10',
          versionNumber: 1,
          sha256: 'j'.repeat(64),
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

      const files = [
        new File(['a'], 'a.pdf', { type: 'application/pdf' }),
        new File(['b'], 'b.pdf', { type: 'application/pdf' }),
      ];
      fireEvent.change(screen.getByLabelText('File', { exact: false }), { target: { files } });

      fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

      await waitFor(() => {
        const uploadCalls = fetchMock.mock.calls.filter(
          ([, init]) => init?.method === 'POST' && init.body instanceof FormData,
        );
        expect(uploadCalls).toHaveLength(2);
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
        if (url === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=desc') {
          return Promise.resolve(jsonResponse({ docs: [completedDoc], count: 1 }));
        }
        if (
          url ===
          '/api/v1/documents?skip=0&limit=25&ingestionStatus=needs-ocr&sort=createdAt&sortDir=desc'
        ) {
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
        if (url === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=desc') {
          return Promise.resolve(jsonResponse({ docs: [pageOneDoc], count: 30 }));
        }
        if (url === '/api/v1/documents?skip=25&limit=25&sort=createdAt&sortDir=desc') {
          return Promise.resolve(jsonResponse({ docs: [pageOneDoc], count: 30 }));
        }
        if (
          url ===
          '/api/v1/documents?skip=0&limit=25&ingestionStatus=needs-ocr&sort=createdAt&sortDir=desc'
        ) {
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
            ([calledUrl]) =>
              calledUrl === '/api/v1/documents?skip=25&limit=25&sort=createdAt&sortDir=desc',
          ),
        ).toBe(true),
      );

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'needs-ocr' },
      });
      expect(await screen.findByText('Scanned Rent Roll')).toBeInTheDocument();
      expect(inTable().getByText('Needs OCR')).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(
          ([calledUrl]) =>
            calledUrl ===
            '/api/v1/documents?skip=0&limit=25&ingestionStatus=needs-ocr&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
      // A filter disables the stream (see the component's own isDefaultView comment); the status
      // line says so instead of quietly reading as still live.
      expect(screen.getByRole('status')).toHaveTextContent('1 document · Updates paused');
      expect(
        screen.getByText('Filter or sort applied — the live channel is off.'),
      ).toBeInTheDocument();
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
        if (url === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=desc') {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        if (
          url ===
          '/api/v1/documents?skip=0&limit=25&ingestionStatus=facts-failed&sort=createdAt&sortDir=desc'
        ) {
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
      expect(await screen.findByText('Northgate Rent Roll')).toBeInTheDocument();
      // Its chunks are committed and citable — a caution, not the rejection tone a failed
      // ingestion carries.
      expect(inTable().getByText('No facts extracted').className).toContain('badge--possible');
      expect(
        screen.getByText('Fact extraction failed: model returned no parseable output'),
      ).toBeInTheDocument();
    });

    it('polls fast while a version is pending and slows to the idle interval once none is', async () => {
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

      await vi.waitFor(() => expect(inTable().getByText('Pending')).toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(inTable().getByText('Completed')).toBeInTheDocument());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // Ingestion resolved on the previous tick, so the interval slows to the idle rate — no
      // extra call yet at the old 3s cadence.
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      // One more call once the slowed, 15s idle interval elapses.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      vi.useRealTimers();
    });

    it('shows a Refresh control only while a filter disables the stream, and it refetches on click', async () => {
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
        count: 1,
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(documents));
      vi.stubGlobal('fetch', fetchMock);

      renderList();
      await screen.findByText('Q3 Rent Roll');
      expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'completed' },
      });
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('1 document · Updates paused'),
      );
      const callsBeforeRefresh = fetchMock.mock.calls.length;

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBeforeRefresh + 1));
    });

    it('drops a slow response once a newer request has resolved, so an out-of-order fetch cannot clobber the current view', async () => {
      const oldResultDoc = {
        id: 'doc-old',
        title: 'Old Slow Result',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-old',
          versionNumber: 1,
          sha256: 'a'.repeat(64),
          sizeBytes: 100,
          ingestionStatus: 'completed',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };
      const newResultDoc = { ...oldResultDoc, id: 'doc-new', title: 'New Fast Result' };

      let resolveSlowRequest: (res: Response) => void;
      const slowResponse = new Promise<Response>((resolve) => {
        resolveSlowRequest = resolve;
      });

      const fetchMock = vi.fn((url: string) => {
        if (
          url ===
          '/api/v1/documents?skip=0&limit=25&ingestionStatus=needs-ocr&sort=createdAt&sortDir=desc'
        ) {
          return slowResponse;
        }
        if (
          url ===
          '/api/v1/documents?skip=0&limit=25&ingestionStatus=failed&sort=createdAt&sortDir=desc'
        ) {
          return Promise.resolve(jsonResponse({ docs: [newResultDoc], count: 1 }));
        }
        // The initial default-view load: left unhandled deliberately — this test only cares
        // about the two filtered requests raced against each other below.
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'needs-ocr' },
      });
      // A second, faster request supersedes the first before it resolves.
      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'failed' },
      });
      expect(await screen.findByText('New Fast Result')).toBeInTheDocument();

      await act(async () => {
        resolveSlowRequest!(jsonResponse({ docs: [oldResultDoc], count: 1 }));
        await slowResponse;
      });

      expect(screen.queryByText('Old Slow Result')).not.toBeInTheDocument();
      expect(screen.getByText('New Fast Result')).toBeInTheDocument();
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
      // A frame landed on a stubbed EventSource, so the stream is genuinely live — the status
      // line says so rather than the 'Polling' it would read without the stub.
      expect(screen.getByRole('status')).toHaveTextContent('1 document · Live');
    });

    it('reports Stale and refetches once the stream misses its heartbeat window', async () => {
      vi.useFakeTimers();
      const liveDoc = {
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
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: [liveDoc], count: 1 }));
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      const [source] = FakeEventSource.instances;
      act(() => {
        source.emit('documents', { docs: [liveDoc], count: 1 });
      });
      await vi.waitFor(() => expect(screen.getByText('Q3 Rent Roll')).toBeInTheDocument());
      expect(fetchMock).not.toHaveBeenCalled();

      // No heartbeat or documents frame for the stale window: the hook gives up on this source
      // and reports 'stale' before its own reconnect attempt.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(35_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent('1 document · Stale');
      expect(screen.getByText('No updates for 35 seconds — reconnecting.')).toBeInTheDocument();

      // No pending version, so the poll gate falls back to the idle interval rather than the
      // pending-ingestion rate.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

      vi.useRealTimers();
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
      expect(firstPageSource.url).toBe('/api/v1/documents/events?skip=0&limit=25');
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
          count: 30,
        });
      });
      await screen.findByText('Q3 Rent Roll');
      expect(firstPageSource.closed).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Next' }));

      // Paging changes the stream URL (`skip=25`), which re-triggers `useEventStream`'s connection
      // effect: the page-1 socket closes and a fresh one opens scoped to the new page — the stream
      // stays live on every page now, not only the first.
      expect(firstPageSource.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(2);
      const [, secondPageSource] = FakeEventSource.instances;
      expect(secondPageSource.url).toBe('/api/v1/documents/events?skip=25&limit=25');
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
          count: 30,
        });
      });

      expect(await screen.findByText('Page Two Doc')).toBeInTheDocument();
    });

    it('returns to the default order, and to a live stream, on a second click of Uploaded', async () => {
      const doc = {
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
        if (url === '/api/v1/documents?skip=0&limit=25&sort=createdAt&sortDir=asc') {
          return Promise.resolve(jsonResponse({ docs: [doc], count: 1 }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      const [firstSource] = FakeEventSource.instances;
      act(() => {
        firstSource.emit('documents', { docs: [doc], count: 1 });
      });
      await screen.findByText('Q3 Rent Roll');
      expect(screen.getByRole('status')).toHaveTextContent('1 document · Live');

      // The default order is createdAt/desc and this is the column that claims it, so a second
      // click on the ascending Uploaded header is the route back to the live default view.
      fireEvent.click(screen.getByRole('button', { name: 'Sort by Uploaded, sorted descending' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent('1 document · Updates paused'),
      );
      expect(firstSource.closed).toBe(true);
      expect(
        screen.getByRole('button', { name: 'Sort by Uploaded, sorted ascending' }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Sort by Uploaded, sorted ascending' }));

      expect(FakeEventSource.instances).toHaveLength(2);
      const [, secondSource] = FakeEventSource.instances;
      act(() => {
        secondSource.emit('documents', { docs: [doc], count: 1 });
      });
      expect(screen.getByRole('status')).toHaveTextContent('1 document · Live');
    });

    it('carries a chosen page size into both the list request and the stream URL', async () => {
      const doc = {
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
      const fetchMock = vi.fn((_url: string) =>
        Promise.resolve(jsonResponse({ docs: [doc], count: 60 })),
      );
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      const [firstSource] = FakeEventSource.instances;
      act(() => {
        firstSource.emit('documents', { docs: [doc], count: 60 });
      });
      await screen.findByText('Q3 Rent Roll');

      fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });

      // A stream left on the old size overwrites a 50-row view with its next 20-row frame, so the
      // two have to move together.
      expect(FakeEventSource.instances).toHaveLength(2);
      const [, resizedSource] = FakeEventSource.instances;
      expect(resizedSource.url).toBe('/api/v1/documents/events?skip=0&limit=50');

      // A filter disables the stream, which is what makes the list request itself observable.
      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'completed' },
      });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([calledUrl]) =>
              calledUrl ===
              '/api/v1/documents?skip=0&limit=50&ingestionStatus=completed&sort=createdAt&sortDir=desc',
          ),
        ).toBe(true),
      );
    });

    it('keeps the stream rows when a filtered fetch that Clear superseded resolves after the first frame', async () => {
      const liveDoc = {
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
      const streamDoc = { ...liveDoc, id: 'doc-2', title: 'Stream Doc After Clear' };
      const failedDoc = {
        ...liveDoc,
        id: 'doc-3',
        title: 'Filtered Failed Doc',
        currentVersion: { ...liveDoc.currentVersion, id: 'v-3', ingestionStatus: 'failed' },
      };
      const filteredUrl =
        '/api/v1/documents?skip=0&limit=25&ingestionStatus=failed&sort=createdAt&sortDir=desc';

      let resolveFiltered: (res: Response) => void;
      const filteredResponse = new Promise<Response>((resolve) => {
        resolveFiltered = resolve;
      });
      const fetchMock = vi.fn((url: string) => {
        if (url === filteredUrl) return filteredResponse;
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      const [firstSource] = FakeEventSource.instances;
      act(() => {
        firstSource.emit('documents', { docs: [liveDoc], count: 1 });
      });
      await screen.findByText('Q3 Rent Roll');

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'failed' },
      });
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([calledUrl]) => calledUrl === filteredUrl)).toBe(true),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

      expect(FakeEventSource.instances).toHaveLength(2);
      const [, secondSource] = FakeEventSource.instances;
      act(() => {
        secondSource.emit('documents', { docs: [streamDoc], count: 1 });
      });
      expect(await screen.findByText('Stream Doc After Clear')).toBeInTheDocument();

      await act(async () => {
        resolveFiltered!(jsonResponse({ docs: [failedDoc], count: 1 }));
        await filteredResponse;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(screen.queryByText('Filtered Failed Doc')).not.toBeInTheDocument();
      expect(screen.getByText('Stream Doc After Clear')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('1 document · Live');
    });

    it('drops a filtered fetch that Clear superseded when it resolves before any stream frame', async () => {
      const liveDoc = {
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
      const failedDoc = {
        ...liveDoc,
        id: 'doc-3',
        title: 'Filtered Failed Doc',
        currentVersion: { ...liveDoc.currentVersion, id: 'v-3', ingestionStatus: 'failed' },
      };
      const filteredUrl =
        '/api/v1/documents?skip=0&limit=25&ingestionStatus=failed&sort=createdAt&sortDir=desc';

      let resolveFiltered: (res: Response) => void;
      const filteredResponse = new Promise<Response>((resolve) => {
        resolveFiltered = resolve;
      });
      const fetchMock = vi.fn((url: string) => {
        if (url === filteredUrl) return filteredResponse;
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      const [firstSource] = FakeEventSource.instances;
      act(() => {
        firstSource.emit('documents', { docs: [liveDoc], count: 1 });
      });
      await screen.findByText('Q3 Rent Roll');

      fireEvent.change(screen.getByLabelText('Ingestion status'), {
        target: { value: 'failed' },
      });
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([calledUrl]) => calledUrl === filteredUrl)).toBe(true),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(FakeEventSource.instances).toHaveLength(2);

      // No frame arrives from the new (default-view) stream before the superseded filtered fetch
      // finally answers — the sequence bump on the isDefaultView change is the only thing dropping
      // it here.
      await act(async () => {
        resolveFiltered!(jsonResponse({ docs: [failedDoc], count: 1 }));
        await filteredResponse;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(screen.queryByText('Filtered Failed Doc')).not.toBeInTheDocument();
      expect(screen.getByText('Q3 Rent Roll')).toBeInTheDocument();
    });

    it('closes the live stream and switches to fetch when a column is sorted, so a late stream frame cannot clobber it', async () => {
      const sortedDoc = {
        id: 'doc-2',
        title: 'Alpha Doc',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersion: {
          id: 'v-2',
          versionNumber: 1,
          sha256: 'b'.repeat(64),
          sizeBytes: 100,
          ingestionStatus: 'completed',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };
      const unsortedFrame = {
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
      };

      const fetchMock = vi.fn((url: string) => {
        // Switching to a different column always starts it at 'desc', matching AnswersPage.tsx
        // and PeoplePage.tsx.
        if (url === '/api/v1/documents?skip=0&limit=25&sort=title&sortDir=desc') {
          return Promise.resolve(jsonResponse({ docs: [sortedDoc], count: 1 }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);

      renderList();

      const [source] = FakeEventSource.instances;
      act(() => {
        source.emit('documents', unsortedFrame);
      });
      expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
      expect(source.closed).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Sort by Title' }));

      expect(await screen.findByText('Alpha Doc')).toBeInTheDocument();
      // Sorting disables the stream the same way a filter does — no new stream opens for a
      // sorted view, and the one that was live for the default view closes.
      expect(source.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(1);

      // A frame on the now-closed stream must not resurrect the unsorted list: its listeners
      // were torn down when the sort disabled the stream.
      act(() => {
        source.emit('documents', unsortedFrame);
      });
      expect(screen.queryByText('Q3 Rent Roll')).not.toBeInTheDocument();
      expect(screen.getByText('Alpha Doc')).toBeInTheDocument();
    });
  });
});
