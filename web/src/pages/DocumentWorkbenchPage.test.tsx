import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocumentWorkbenchPage from './DocumentWorkbenchPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// jsdom implements neither method — stubbing the real `URL` class (rather than a bare object)
// keeps every other URL/URLSearchParams behaviour elsewhere in the render tree working exactly as
// it does outside the test.
function stubObjectUrl(): void {
  let counter = 0;
  const createObjectURL = vi.fn(() => `blob:mock-${(counter += 1)}`);
  const revokeObjectURL = vi.fn();
  class StubUrl extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal('URL', StubUrl);
}

function pdfVersion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'version-1',
    versionNumber: 1,
    sha256: 'a'.repeat(64),
    sizeBytes: 245_760,
    ingestionStatus: 'completed',
    reducedFidelityReasons: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function documentWithVersion(sourceKind: string, version: ReturnType<typeof pdfVersion>) {
  return {
    id: 'doc-1',
    title: 'Q3 Rent Roll',
    sourceKind,
    mimeType: 'application/pdf',
    sourceClass: 'unclassified',
    currentVersion: version,
    createdAt: new Date().toISOString(),
    versions: [version],
  };
}

// A stored evidence chunk, defaulted to a pdf-page locator — override `locator` for the other
// five kinds `EvidenceReader` groups by.
function evidenceChunk(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chunk-1',
    text: 'The cap rate for Northgate Business Park is approximately 6.10%.',
    tokenCount: 12,
    locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    ...overrides,
  };
}

// No stored chunks, for a test that only cares about the version pane and would otherwise leave
// `EvidenceReader`'s own fetch unhandled.
function emptyChunksResponse(): Response {
  return jsonResponse({ docs: [], count: 0 });
}

// Dispatches by URL, matching DocumentDetail.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(documentId: string, versionId: string, search = '') {
  render(
    <MemoryRouter initialEntries={[`/documents/${documentId}/versions/${versionId}${search}`]}>
      <Routes>
        <Route
          path="/documents/:documentId/versions/:versionId"
          element={<DocumentWorkbenchPage />}
        />
        <Route path="/documents/:id" element={<p>document detail probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DocumentWorkbenchPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows a loading state before the document arrives', async () => {
    let resolveDoc: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveDoc = resolve;
    });
    stubFetch({ '/api/v1/documents/doc-1': () => pending });

    renderAt('doc-1', 'version-1');

    expect(screen.getByText('Loading document…')).toBeInTheDocument();

    resolveDoc!(jsonResponse(documentWithVersion('pdf', pdfVersion())));
    expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
  });

  it('renders a completed PDF version inline via a blob object URL', async () => {
    stubObjectUrl();
    const version = pdfVersion();
    const fetchMock = stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('pdf', version)),
      '/api/v1/documents/versions/version-1/content': () =>
        Promise.resolve(new Response(new Blob(['pdf-bytes'], { type: 'application/pdf' }))),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1');

    expect(await screen.findByTitle('Q3 Rent Roll, version 1')).toHaveAttribute(
      'src',
      'blob:mock-1',
    );
    // Rendered twice by design: once as the header's at-a-glance badge, once as the detail rail's
    // labelled "Status" row.
    expect(screen.getAllByText('Completed')).toHaveLength(2);
    expect(screen.getByText(/^Version 1 · uploaded /)).toBeInTheDocument();
    const downloadLink = screen.getByRole('link', { name: 'Download' });
    expect(downloadLink).toHaveAttribute('href', '/api/v1/documents/versions/version-1/content');
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/documents/versions/version-1/content'),
    ).toBe(true);
  });

  it('surfaces a failed content fetch in the pane instead of leaving it blank', async () => {
    stubObjectUrl();
    const version = pdfVersion();
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('pdf', version)),
      '/api/v1/documents/versions/version-1/content': () =>
        jsonResponse({ message: 'Content unavailable' }, 500),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Content unavailable');
  });

  it('shows the reduced-fidelity badge and reasons on a lossy version', async () => {
    stubObjectUrl();
    const version = pdfVersion({
      reducedFidelityReasons: ['Falling back to OCR-only extraction for 2 of 3 pages'],
    });
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('pdf', version)),
      '/api/v1/documents/versions/version-1/content': () =>
        Promise.resolve(new Response(new Blob(['pdf-bytes']))),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1');

    expect(await screen.findByText('reduced fidelity')).toBeInTheDocument();
    expect(
      screen.getByText('Falling back to OCR-only extraction for 2 of 3 pages'),
    ).toBeInTheDocument();
  });

  it('jumps the PDF pane to the cited page when ?chunk= resolves to a pdf-page locator', async () => {
    stubObjectUrl();
    const version = pdfVersion();
    const chunk = evidenceChunk({ locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 } });
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('pdf', version)),
      '/api/v1/documents/versions/version-1/content': () =>
        Promise.resolve(new Response(new Blob(['pdf-bytes']))),
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [chunk], count: 1 }),
    });

    renderAt('doc-1', 'version-1', '?chunk=chunk-1');

    // The resolved page mounts a fresh iframe, so the element is re-queried inside the wait rather
    // than held across the remount. jsdom runs no PDF viewer: this asserts the fragment the pane
    // hands the browser, never that a viewer honours it.
    await screen.findByTitle('Q3 Rent Roll, version 1');
    await waitFor(() =>
      expect(screen.getByTitle('Q3 Rent Roll, version 1')).toHaveAttribute(
        'src',
        'blob:mock-1#page=3',
      ),
    );

    const target = await screen.findByText(chunk.text);
    expect(target.closest('li')).toHaveAttribute('aria-current', 'location');
  });

  it('shows an inline warning, not a 404, when ?chunk= matches no stored chunk', async () => {
    stubObjectUrl();
    const version = pdfVersion();
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('pdf', version)),
      '/api/v1/documents/versions/version-1/content': () =>
        Promise.resolve(new Response(new Blob(['pdf-bytes']))),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1', '?chunk=missing-chunk');

    expect(await screen.findByText(/is not part of this/)).toBeInTheDocument();
    expect(screen.queryByText('Document not found.')).not.toBeInTheDocument();
  });

  it('renders the evidence reader as the primary experience for a non-PDF source kind, without fetching content bytes', async () => {
    const version = pdfVersion();
    const chunkA = evidenceChunk({
      id: 'chunk-1',
      text: 'The cap rate for Northgate is 6.10%.',
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
    });
    const chunkB = evidenceChunk({
      id: 'chunk-2',
      text: 'Occupancy sits at 94% as of Q3.',
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Rent Roll', cell: 'A1' },
    });
    const fetchMock = stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('xlsx', version)),
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [chunkA, chunkB], count: 2 }),
    });

    renderAt('doc-1', 'version-1');

    expect(await screen.findByText('Comps')).toBeInTheDocument();
    expect(screen.getByText('Rent Roll')).toBeInTheDocument();
    const chunkAItem = screen.getByText(chunkA.text).closest('li');
    expect(
      within(chunkAItem as HTMLElement).getByRole('button', { name: /display text/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/documents/versions/version-1/content'),
    ).toBe(false);
  });

  it('filters chunks by search text and highlights the match', async () => {
    const version = pdfVersion();
    const chunkA = evidenceChunk({
      id: 'chunk-1',
      text: 'The cap rate is 6.10%.',
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
    });
    const chunkB = evidenceChunk({
      id: 'chunk-2',
      text: 'Occupancy sits at 94%.',
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'A1' },
    });
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('xlsx', version)),
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [chunkA, chunkB], count: 2 }),
    });

    renderAt('doc-1', 'version-1');

    const search = await screen.findByLabelText('Search this document');
    fireEvent.change(search, { target: { value: 'occupancy' } });

    expect(screen.queryByText(chunkA.text)).not.toBeInTheDocument();
    expect(screen.getByText('Occupancy', { selector: 'mark' })).toBeInTheDocument();
  });

  it('never fetches content bytes for a non-PDF source kind, offering only the download instead', async () => {
    stubObjectUrl();
    const version = pdfVersion();
    const fetchMock = stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('xlsx', version)),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1');

    await screen.findByText('No evidence chunks are stored for this version.');
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/documents/versions/version-1/content'),
    ).toBe(false);
  });

  it('shows a calm not-found notice for a missing document', async () => {
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse({ message: 'Document not found' }, 404),
    });

    renderAt('doc-1', 'version-1');

    expect(await screen.findByText('Document not found.')).toBeInTheDocument();
  });

  it('surfaces a non-404 load failure as an alert rather than a not-found notice', async () => {
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse({ message: 'Upstream unavailable' }, 500),
    });

    renderAt('doc-1', 'version-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Upstream unavailable');
    expect(screen.queryByText('Document not found.')).not.toBeInTheDocument();
  });

  it('advances the version named in the URL from pending as the poll ticks', async () => {
    vi.useFakeTimers();
    // The document's current version is a later, completed one: only the version the URL names is
    // still ingesting, so a poll gated on `currentVersion` would never run.
    const currentVersion = pdfVersion({ id: 'version-2', versionNumber: 2 });
    const urlVersion = pdfVersion({ ingestionStatus: 'pending' });
    let call = 0;
    stubFetch({
      '/api/v1/documents/doc-1': () => {
        call += 1;
        return jsonResponse({
          ...documentWithVersion('xlsx', currentVersion),
          versions: [call === 1 ? urlVersion : pdfVersion(), currentVersion],
        });
      },
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1');

    await vi.waitFor(() => expect(screen.getAllByText('Pending').length).toBeGreaterThan(0));
    expect(
      screen.getByText(
        'Ingestion is still running for this version — evidence chunks appear as they are stored.',
      ),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    await vi.waitFor(() => expect(screen.queryByText('Pending')).not.toBeInTheDocument());
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.getByText('No evidence chunks are stored for this version.')).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('keeps the status badge and the Back button together in the header actions slot', async () => {
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('xlsx', pdfVersion())),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1');

    // The Back link renders from `documentId` alone, on the first paint; the status badge waits
    // on the document fetch, one render later — the two only share a commit once that resolves.
    const back = await screen.findByRole('link', { name: 'Back to document' });
    const actions = back.closest('.page-head-actions');
    expect(actions).not.toBeNull();
    await waitFor(() => {
      expect(within(actions as HTMLElement).getByText('Completed')).toBeInTheDocument();
    });
  });

  it('copies the full sha256 from the version card while the row shows the truncated digest', async () => {
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('xlsx', pdfVersion())),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderAt('doc-1', 'version-1');

    const copy = await screen.findByRole('button', { name: 'Copy sha256' });
    expect(screen.queryByText('a'.repeat(64))).not.toBeInTheDocument();

    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('a'.repeat(64)));
  });

  it('opens the full sha256 tooltip when keyboard focus reaches the truncated digest', async () => {
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('xlsx', pdfVersion())),
      '/api/v1/documents/versions/version-1/chunks': emptyChunksResponse,
    });

    renderAt('doc-1', 'version-1');

    const digest = await screen.findByText(`${'a'.repeat(8)}…${'a'.repeat(4)}`);
    expect(digest).toHaveAttribute('tabindex', '0');

    digest.focus();
    const surface = await screen.findByRole('tooltip');
    expect(surface).toHaveTextContent('a'.repeat(64));
    expect(digest).toHaveAttribute('aria-describedby', surface.id);
  });

  it('flags a version id that does not belong to the loaded document', async () => {
    stubFetch({
      '/api/v1/documents/doc-1': () => jsonResponse(documentWithVersion('pdf', pdfVersion())),
    });

    renderAt('doc-1', 'version-does-not-exist');

    expect(
      await screen.findByText('This version does not belong to this document.'),
    ).toBeInTheDocument();
  });
});
