import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetrievedChunkView } from '../api/client';
import SearchPage from './SearchPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Drives the fake clock and lets each fetch settle through its response-parsing promise chain,
// so assertions read committed state instead of racing it.
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const chunk: RetrievedChunkView = {
  chunkId: 'chunk-1',
  docVersionId: 'docver-1',
  sha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  text: 'Cap rate for Northgate is 6.1%.',
  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
  documentId: 'doc-1',
  documentTitle: 'Northgate lease abstract',
  // A realistic fused RRF value, near the ~0.0328 ceiling rather than a 0-1 similarity.
  score: 0.0328,
};

const chunk2: RetrievedChunkView = {
  chunkId: 'chunk-2',
  docVersionId: 'docver-2',
  sha256: 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  text: 'Occupancy for the Riverside Center rose to 92% in Q4.',
  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
  documentId: 'doc-2',
  documentTitle: 'Riverside Center memo',
  score: 0.02,
};

function renderPage() {
  render(
    <MemoryRouter>
      <SearchPage />
    </MemoryRouter>,
  );
}

function search(query = 'cap rate') {
  fireEvent.change(screen.getByLabelText('Search query'), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

// A highlighted quote splits its text across the `<mark>` elements it wraps, so no single node's
// own text content equals the whole quote — this reassembles it from a node whose full
// `textContent` matches but whose immediate children's do not, the standard way to match text
// split across markup.
function findQuoteText(text: string) {
  return screen.findByText((_content, node) => {
    if (!node || node.textContent !== text) return false;
    return Array.from(node.children).every((child) => child.textContent !== text);
  });
}

describe('SearchPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('invites a search before any has run, and fires no request on a keystroke', () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('unexpected fetch')));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(screen.getByText('Search the evidence corpus')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'cap rate' } });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fires exactly one request on submit and renders the result with its locator and workbench link', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/retrieval/search')) {
        return Promise.resolve(jsonResponse({ docs: [chunk], hasMore: false }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    search();

    expect(await findQuoteText('Cap rate for Northgate is 6.1%.')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
    expect(screen.getByText('1 on this page')).toBeInTheDocument();

    const link = screen.getByTitle(`sha256 ${chunk.sha256} · chunk chunk-1`);
    expect(link).toHaveAttribute('href', '/documents/doc-1/versions/docver-1?chunk=chunk-1');

    const searchCalls = fetchMock.mock.calls.filter(([url]) =>
      url.startsWith('/api/v1/retrieval/search'),
    );
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0][0]).toBe('/api/v1/retrieval/search?query=cap+rate&skip=0&limit=20');
  });

  it('groups results by document rather than rendering a flat list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ docs: [chunk, chunk2], hasMore: false }))),
    );

    renderPage();
    search();

    expect(
      await screen.findByRole('heading', { name: 'Northgate lease abstract' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Riverside Center memo' })).toBeInTheDocument();
    expect(
      screen.getByText('Occupancy for the Riverside Center rose to 92% in Q4.'),
    ).toBeInTheDocument();
  });

  it('highlights matched query terms within a result quote', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ docs: [chunk], hasMore: false }))),
    );

    renderPage();
    search();

    const capMark = await screen.findByText('Cap');
    expect(capMark.tagName).toBe('MARK');
    expect(screen.getByText('rate').tagName).toBe('MARK');
  });

  it('never renders the fused score as a percentage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ docs: [chunk], hasMore: false }))),
    );

    renderPage();
    search();

    await screen.findByText('Cap');
    // score is 0.0328; a naive `Math.round(score * 100)}%` rendering would show '3%'.
    expect(screen.queryByText('3%')).not.toBeInTheDocument();
    expect(screen.queryByText('3.28%')).not.toBeInTheDocument();
  });

  it('applies the source class filter and refetches with it as a query parameter', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/retrieval/search')) {
        return Promise.resolve(jsonResponse({ docs: [chunk], hasMore: false }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    search();
    await screen.findByRole('heading', { name: 'Northgate lease abstract' });

    fireEvent.change(screen.getByLabelText('Source class'), { target: { value: 'memo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => {
      const searchCalls = fetchMock.mock.calls.filter(([url]) =>
        url.startsWith('/api/v1/retrieval/search'),
      );
      expect(searchCalls).toHaveLength(2);
    });
    const searchCalls = fetchMock.mock.calls.filter(([url]) =>
      url.startsWith('/api/v1/retrieval/search'),
    );
    expect(searchCalls[1][0]).toContain('sourceClass=memo');
  });

  it('marks more results as available when the response says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/v1/retrieval/search')) {
          return Promise.resolve(jsonResponse({ docs: [chunk], hasMore: true }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      }),
    );

    renderPage();
    search();

    expect(await screen.findByText('1 on this page · more available')).toBeInTheDocument();
  });

  it('shows a no-results state, distinct from the pre-search invitation, when a search finds nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ docs: [], hasMore: false }))),
    );

    renderPage();
    search();

    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(screen.queryByText('Search the evidence corpus')).not.toBeInTheDocument();
  });

  it('shows the rate-limit message and disables submission, re-enabling once the cooldown window clears', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'Too many requests' }, 429))),
    );

    renderPage();
    search();
    await tick();

    expect(screen.getByRole('alert')).toHaveTextContent(/limited to 10 queries per minute/i);
    const cooldownButton = screen.getByRole('button', { name: /Wait \d+s/ });
    expect(cooldownButton).toBeDisabled();

    // The countdown re-arms itself one second at a time (each tick schedules the next), so the
    // fake clock is advanced the same way rather than in one 60s jump.
    for (let elapsed = 0; elapsed < 60; elapsed += 1) {
      await tick(1000);
    }

    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it('shows the server error message on a non-429 failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'Search backend unavailable' }, 500))),
    );

    renderPage();
    search();

    expect(await screen.findByRole('alert')).toHaveTextContent('Search backend unavailable');
  });
});
