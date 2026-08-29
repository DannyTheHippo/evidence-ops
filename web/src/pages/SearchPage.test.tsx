import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetrievedChunkView } from '../api/client';
import SearchPage from './SearchPage';

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Stands in for AskPage at the far end of the "Ask a question" cross-link — enough to read back
// the router state SearchPage hands it, without pulling in AskPage's own dependencies.
function AskDestinationStub() {
  const location = useLocation();
  const state = location.state as { questionText?: string } | null;
  return <p>Ask destination: {state?.questionText || '(empty)'}</p>;
}

function renderPageWithAskRoute() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/ask" element={<AskDestinationStub />} />
      </Routes>
    </MemoryRouter>,
  );
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
  sourceClass: 'pm-export',
  documentCreatedAt: '2026-03-14T09:12:00.000Z',
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
  sourceClass: 'memo',
  documentCreatedAt: '2026-01-08T16:45:00.000Z',
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
    expect(screen.getByText('Showing 1–1')).toBeInTheDocument();

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

    expect(await screen.findByText('Showing 1–1 · more available')).toBeInTheDocument();
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
    // No filter is applied in this scenario, so there is nothing to clear.
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ask a question/ })).toBeInTheDocument();
  });

  it('offers a refinement path, including clearing the active filter, when a filtered search finds nothing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/retrieval/search')) {
        return Promise.resolve(jsonResponse({ docs: [], hasMore: false }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    search();
    await screen.findByText('No results');

    fireEvent.change(screen.getByLabelText('Source class'), { target: { value: 'memo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => {
      const searchCalls = fetchMock.mock.calls.filter(([url]) =>
        url.startsWith('/api/v1/retrieval/search'),
      );
      expect(searchCalls).toHaveLength(2);
    });

    // Two "Clear filters" controls are on screen at once here: FilterBar's own (always available
    // once a filter is applied) and the no-results state's contextual one — either clears the
    // same filter state, so this exercises the latter.
    const clearButtons = await screen.findAllByRole('button', { name: 'Clear filters' });
    expect(clearButtons).toHaveLength(2);
    fireEvent.click(clearButtons[1]);

    await waitFor(() => {
      const searchCalls = fetchMock.mock.calls.filter(([url]) =>
        url.startsWith('/api/v1/retrieval/search'),
      );
      expect(searchCalls).toHaveLength(3);
    });
    const searchCalls = fetchMock.mock.calls.filter(([url]) =>
      url.startsWith('/api/v1/retrieval/search'),
    );
    expect(searchCalls[2][0]).not.toContain('sourceClass');
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
    // The button's accessible name never changes while disabled — only the chip beside it counts
    // down — so the same query finds it before and after the window elapses.
    const cooldownButton = screen.getByRole('button', { name: 'Search' });
    expect(cooldownButton).toBeDisabled();
    expect(screen.getByText('1:00')).toBeInTheDocument();

    // The countdown re-arms itself one second at a time (each tick schedules the next), so the
    // fake clock is advanced the same way rather than in one 60s jump. No Retry-After header was
    // sent, so this falls back to the flat 60-second window.
    for (let elapsed = 0; elapsed < 60; elapsed += 1) {
      await tick(1000);
    }

    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
    // The alert clears alongside the chip once the window elapses, rather than lingering until
    // some unrelated state change dismisses it.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('0:00')).not.toBeInTheDocument();
  });

  it('reads the true cooldown window from Retry-After instead of assuming the full 60 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ message: 'Too many requests' }, 429, { 'Retry-After': '5' }),
        ),
      ),
    );

    renderPage();
    search();
    await tick();

    expect(screen.getByText('0:05')).toBeInTheDocument();

    for (let elapsed = 0; elapsed < 5; elapsed += 1) {
      await tick(1000);
    }

    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('shows a validation error and focuses the input on an empty submit, rather than doing nothing', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('unexpected fetch')));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Enter a search query.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Search query')).toHaveFocus());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fills and focuses the search input from a static example chip', () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('unexpected fetch')));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'cap rate for Northgate Business Park' }));

    expect(screen.getByLabelText('Search query')).toHaveValue(
      'cap rate for Northgate Business Park',
    );
    expect(screen.getByLabelText('Search query')).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('links to Ask with the current query carried as router state', async () => {
    renderPageWithAskRoute();

    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'cap rate' } });
    fireEvent.click(screen.getByRole('link', { name: /Ask a question/ }));

    expect(await screen.findByText('Ask destination: cap rate')).toBeInTheDocument();
  });
});
