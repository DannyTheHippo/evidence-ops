import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MetricPackList from './MetricPackList';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const draftPack = {
  id: 'pack-1',
  packId: 'cre-fork',
  version: 2,
  status: 'draft',
  label: 'CRE Fork',
  metrics: [],
  createdAt: '2026-07-01T00:00:00.000Z',
};

function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('MetricPackList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists each pack version with its packId, version and status, linking to its detail page', async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ docs: [draftPack], count: 1 }),
    });

    render(
      <MemoryRouter>
        <MetricPackList />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('link', { name: 'cre-fork' })).toHaveAttribute(
      'href',
      '/metric-packs/cre-fork/2',
    );
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('CRE Fork')).toBeInTheDocument();
  });

  it('shows an empty state when the tenant has authored no pack versions', async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ docs: [], count: 0 }),
    });

    render(
      <MemoryRouter>
        <MetricPackList />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No authored pack versions yet')).toBeInTheDocument();
  });

  it('renders the load error instead of the table', async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ message: 'Metric packs unavailable' }, 500),
    });

    render(
      <MemoryRouter>
        <MetricPackList />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Metric packs unavailable');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
