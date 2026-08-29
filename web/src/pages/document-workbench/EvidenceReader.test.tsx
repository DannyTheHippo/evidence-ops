import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EvidenceReader from './EvidenceReader';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A stored evidence chunk, defaulted to a pdf-page locator — matching DocumentWorkbenchPage.
// test.tsx's fixture, since both exercise the same `EvidenceChunkView` shape.
function evidenceChunk(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chunk-1',
    text: 'The cap rate for Northgate Business Park is approximately 6.10%.',
    tokenCount: 12,
    locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    ...overrides,
  };
}

function stubFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderReader(versionId: string, search = '', variant?: 'reading' | 'rail') {
  return render(
    <MemoryRouter initialEntries={[`/documents/doc-1/versions/${versionId}${search}`]}>
      <EvidenceReader versionId={versionId} variant={variant} />
    </MemoryRouter>,
  );
}

describe('EvidenceReader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('groups chunks by locator, opening only the first group by default', async () => {
    const pageThree = evidenceChunk({
      id: 'chunk-1',
      text: 'The cap rate is 6.10%.',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    });
    const pageFive = evidenceChunk({
      id: 'chunk-2',
      text: 'Occupancy sits at 94%.',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
    });
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [pageThree, pageFive], count: 2 }),
    });

    renderReader('version-1');

    const pageThreeGroup = (await screen.findByText('Page 3')).closest('details');
    const pageFiveGroup = screen.getByText('Page 5').closest('details');
    expect(pageThreeGroup).toHaveAttribute('open');
    expect(pageFiveGroup).not.toHaveAttribute('open');
  });

  it('opens the targeted group and marks the targeted chunk aria-current', async () => {
    const pageThree = evidenceChunk({
      id: 'chunk-1',
      text: 'The cap rate is 6.10%.',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    });
    const pageFive = evidenceChunk({
      id: 'chunk-2',
      text: 'Occupancy sits at 94%.',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
    });
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [pageThree, pageFive], count: 2 }),
    });

    renderReader('version-1', '?chunk=chunk-2');

    const pageFiveGroup = (await screen.findByText('Page 5')).closest('details');
    expect(pageFiveGroup).toHaveAttribute('open');

    const target = screen.getByText(pageFive.text).closest('li');
    expect(target).toHaveAttribute('aria-current', 'location');
    const untargeted = screen.getByText(pageThree.text).closest('li');
    expect(untargeted).not.toHaveAttribute('aria-current');
  });

  it('shows an inline warning, not a crash, when ?chunk= matches no stored chunk', async () => {
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [evidenceChunk()], count: 1 }),
    });

    renderReader('version-1', '?chunk=missing-chunk');

    expect(await screen.findByText(/is not part of this/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('filters chunks by search text and highlights the match', async () => {
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
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [chunkA, chunkB], count: 2 }),
    });

    renderReader('version-1');

    const search = await screen.findByLabelText('Search this document');
    fireEvent.change(search, { target: { value: 'occupancy' } });

    expect(screen.queryByText(chunkA.text)).not.toBeInTheDocument();
    expect(screen.getByText('Occupancy', { selector: 'mark' })).toBeInTheDocument();
  });

  it('offers a copy-as-citation control stating it copies display text', async () => {
    const chunk = evidenceChunk();
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [chunk], count: 1 }),
    });

    renderReader('version-1');

    const item = (await screen.findByText(chunk.text)).closest('li');
    expect(
      within(item as HTMLElement).getByRole('button', { name: 'Copy citation (display text)' }),
    ).toBeInTheDocument();
  });

  it('carries the reading-variant modifier class when asked for the primary reading surface', async () => {
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [evidenceChunk()], count: 1 }),
    });

    const { container } = renderReader('version-1', '', 'reading');

    await screen.findByText(/cap rate/);
    expect(container.querySelector('.evidence-reader')).toHaveClass('evidence-reader--reading');
  });

  it('defaults to the rail-variant modifier class when no variant is given', async () => {
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [evidenceChunk()], count: 1 }),
    });

    const { container } = renderReader('version-1');

    await screen.findByText(/cap rate/);
    expect(container.querySelector('.evidence-reader')).toHaveClass('evidence-reader--rail');
  });

  it("labels each group's summary with its own chunk count", async () => {
    const pageThree = evidenceChunk({
      id: 'chunk-1',
      text: 'The cap rate is 6.10%.',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    });
    const pageThreeAlso = evidenceChunk({
      id: 'chunk-2',
      text: 'Occupancy sits at 94%.',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
    });
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [pageThree, pageThreeAlso], count: 2 }),
    });

    renderReader('version-1');

    const group = (await screen.findByText('Page 3')).closest('details');
    expect(within(group as HTMLElement).getByText('2 chunks')).toBeInTheDocument();
  });

  it('reports a match count when the search finds chunks, and nothing else', async () => {
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
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [chunkA, chunkB], count: 2 }),
    });

    renderReader('version-1');

    const search = await screen.findByLabelText('Search this document');
    fireEvent.change(search, { target: { value: 'occupancy' } });

    const status = await screen.findByText('1 chunk matches');
    expect(status).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/No chunks match/)).not.toBeInTheDocument();
  });

  it('reports the no-match message when the search finds nothing, and no count', async () => {
    stubFetch({
      '/api/v1/documents/versions/version-1/chunks': () =>
        jsonResponse({ docs: [evidenceChunk()], count: 1 }),
    });

    renderReader('version-1');

    const search = await screen.findByLabelText('Search this document');
    fireEvent.change(search, { target: { value: 'no such passage' } });

    const status = await screen.findByText('No chunks match “no such passage”.');
    expect(status).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/matches$/)).not.toBeInTheDocument();
  });
});
