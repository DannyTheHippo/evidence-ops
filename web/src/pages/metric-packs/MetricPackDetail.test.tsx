import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, getToasts } from '../../components/ui/toast';
import MetricPackDetail from './MetricPackDetail';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const capRateMetric = {
  id: 'cap_rate',
  label: 'Cap Rate',
  aliases: ['Cap Rate', 'cap rate'],
  valueType: 'percentage',
  canonicalUnit: 'ratio',
  units: [{ id: 'ratio', toCanonicalFactor: 1 }],
  toleranceKind: 'absolute',
  tolerance: 0.0025,
  authorityOrder: ['pm-export'],
  stalenessWindowMs: 15_552_000_000,
};

const draftPack = {
  id: 'pack-1',
  packId: 'cre-fork',
  version: 2,
  status: 'draft',
  label: 'CRE Fork',
  metrics: [capRateMetric],
  parentPackId: 'cre',
  parentVersion: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const publishedPack = { ...draftPack, status: 'published' };
const activePack = { ...draftPack, status: 'active' };

// Dispatches by URL and method, matching DocumentDetail.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler)
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderDetail(packId = 'cre-fork', version = 2) {
  render(
    <MemoryRouter>
      <MetricPackDetail packId={packId} version={version} />
    </MemoryRouter>,
  );
}

describe('MetricPackDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearToasts();
  });

  it("shows the version's metrics", async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ docs: [draftPack], count: 1 }),
    });

    renderDetail();

    expect(await screen.findByRole('heading', { name: 'CRE Fork' })).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('Cap Rate')).toBeInTheDocument();
    expect(screen.getByText('percentage')).toBeInTheDocument();
    expect(screen.getByText('absolute · 0.0025')).toBeInTheDocument();
    expect(screen.getByText('Drafted from cre v1.')).toBeInTheDocument();
  });

  it('shows a calm not-found notice for an unknown version', async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderDetail();

    expect(await screen.findByText('Metric pack version not found.')).toBeInTheDocument();
  });

  it('publishes a draft after confirming in the dialog, then reloads the list', async () => {
    // The list GET is hit twice — once on mount, once after publish succeeds — and must answer
    // differently each time, which is why this dispatches on a flag rather than a static route
    // table.
    let published = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/metric-packs/cre-fork/versions/2/publish' && init?.method === 'POST') {
        published = true;
        return Promise.resolve(jsonResponse({ ...draftPack, status: 'published' }));
      }
      if (url === '/api/v1/metric-packs') {
        return Promise.resolve(
          jsonResponse({ docs: [published ? publishedPack : draftPack], count: 1 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    const dialog = screen.getByRole('dialog', { name: 'Publish cre-fork v2?' });
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));

    expect(await screen.findByText('published')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === '/api/v1/metric-packs/cre-fork/versions/2/publish' && init?.method === 'POST',
      ),
    ).toBe(true);
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Published cre-fork v2.' }),
    );
  });

  it('surfaces the server refusal message when publish is rejected', async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ docs: [draftPack], count: 1 }),
      '/api/v1/metric-packs/cre-fork/versions/2/publish': () =>
        jsonResponse(
          { message: "Publishing pack 'cre-fork' v2 would drop metric(s) lease_term_years" },
          409,
        ),
    });

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Publishing pack 'cre-fork' v2 would drop metric(s) lease_term_years",
    );
  });

  it('shows per-metric preview counts before the activate confirmation fires', async () => {
    // Same call-order dispatch as the publish test: the list GET must answer 'published' before
    // activation and 'active' after it.
    let activated = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/metric-packs/cre-fork/versions/2/preview' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ metrics: [{ metricId: 'cap_rate', wouldCreate: 2, wouldRetract: 3 }] }),
        );
      }
      if (url === '/api/v1/metric-packs/cre-fork/versions/2/activate' && init?.method === 'POST') {
        activated = true;
        return Promise.resolve(jsonResponse({ ...publishedPack, status: 'active' }));
      }
      if (url === '/api/v1/metric-packs') {
        return Promise.resolve(
          jsonResponse({ docs: [activated ? activePack : publishedPack], count: 1 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    // The preview loads inside the same dialog as the final confirm, and its numbers land before
    // anything is committed — no POST to /activate has fired yet.
    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === '/api/v1/metric-packs/cre-fork/versions/2/activate' && init?.method === 'POST',
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Activate version' }));

    expect(
      await screen.findByText("This is the tenant's currently active version."),
    ).not.toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === '/api/v1/metric-packs/cre-fork/versions/2/activate' && init?.method === 'POST',
      ),
    ).toBe(true);
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Activated cre-fork v2.' }),
    );
  });

  it('names a labels-only draft explicitly rather than showing an empty preview table', async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ docs: [publishedPack], count: 1 }),
      '/api/v1/metric-packs/cre-fork/versions/2/preview': () => jsonResponse({ metrics: [] }),
    });

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    const dialog = await screen.findByRole('dialog', { name: 'Activate cre-fork v2?' });
    expect(
      await within(dialog).findByText(
        'No detection-relevant changes; activating starts no rescan.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('table')).not.toBeInTheDocument();
  });

  it('cancelling the activate dialog closes it without activating', async () => {
    stubFetch({
      '/api/v1/metric-packs': () => jsonResponse({ docs: [publishedPack], count: 1 }),
      '/api/v1/metric-packs/cre-fork/versions/2/preview': () =>
        jsonResponse({ metrics: [{ metricId: 'cap_rate', wouldCreate: 0, wouldRetract: 0 }] }),
    });

    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    await screen.findByRole('table', { name: /Per-metric conflict counts/ });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
