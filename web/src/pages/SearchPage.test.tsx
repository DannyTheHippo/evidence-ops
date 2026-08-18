import { fireEvent, render, screen } from '@testing-library/react';
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

const chunk: RetrievedChunkView = {
  chunkId: 'chunk-1',
  docVersionId: 'docver-1',
  sha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  text: 'Cap rate for Northgate is 6.1%.',
  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
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

describe('SearchPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('invites a search before any has run, and fires no request on a keystroke', () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('unexpected fetch')));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(screen.getByText('Search the evidence corpus')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'cap rate' } });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fires exactly one request on submit and renders the result with its locator and trace chip', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/retrieval/search')) {
        return Promise.resolve(jsonResponse({ docs: [chunk], count: 1 }));
      }
      if (url === '/api/v1/documents') return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    search();

    expect(await screen.findByText('Cap rate for Northgate is 6.1%.')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
    expect(screen.getByTitle(`sha256 ${chunk.sha256} · chunk chunk-1`)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/v1/retrieval/search')).length,
    ).toBe(1);
  });

  it('shows a no-results state, distinct from the pre-search invitation, when a search finds nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ docs: [], count: 0 }))),
    );

    renderPage();
    search();

    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(screen.queryByText('Search the evidence corpus')).not.toBeInTheDocument();
  });

  it('shows the rate-limit message on a 429 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'Too many requests' }, 429))),
    );

    renderPage();
    search();

    expect(await screen.findByRole('alert')).toHaveTextContent(/limited to 10 queries per minute/i);
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
