import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import MeasuresPage from './MeasuresPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const admin = {
  id: 'user-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  createdAt: new Date().toISOString(),
};

const member = {
  id: 'user-2',
  email: 'member@example.com',
  role: 'member' as const,
  createdAt: new Date().toISOString(),
};

const versionLookup = {
  versionId: 'docver-1',
  documentId: 'doc-1',
  documentTitle: 'Rent Roll Q1',
  versionNumber: 1,
  sourceKind: 'pdf',
  withdrawn: false,
};

const proposedMeasure = {
  id: 'measure-1',
  slug: 'cap_rate',
  label: 'Cap Rate',
  aliases: [],
  valueType: 'percentage',
  canonicalUnit: 'ratio',
  units: [],
  toleranceKind: 'absolute',
  tolerance: 0.0025,
  status: 'proposed',
  origin: 'header',
  proposedFrom: [
    {
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      headerText: 'Cap Rate',
    },
  ],
  version: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const PROPOSED_URL = '/api/v1/measures?status=proposed&skip=0&limit=20';

// Dispatches by URL, matching every other list-page test's `stubFetch` convention — a route this
// doesn't recognize rejects rather than silently returning nothing.
function stubFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (handler) return Promise.resolve(handler());
    return Promise.reject(new Error(`Unhandled fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  render(
    <MemoryRouter>
      <MeasuresPage />
    </MemoryRouter>,
  );
}

function queueRegion() {
  return screen.findByRole('region', { name: 'Measures queue' });
}

function detailRegion() {
  return screen.findByRole('region', { name: 'Measure detail' });
}

describe('MeasuresPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists a proposed measure with its header evidence and a workbench link once the document resolves', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PROPOSED_URL]: () => jsonResponse({ docs: [proposedMeasure], count: 1 }),
      '/api/v1/documents/versions/lookup?versionIds=docver-1': () =>
        jsonResponse({ docs: [versionLookup], count: 1 }),
    });

    renderPage();

    const queue = await queueRegion();
    expect(within(queue).getByText('Cap Rate')).toBeInTheDocument();
    expect(within(queue).getByText('proposed')).toBeInTheDocument();
    expect(within(queue).getByText('cap_rate')).toBeInTheDocument();
    expect(queue.textContent).toContain('percentage · ratio · 1 header');

    const detail = await detailRegion();
    expect(within(detail).getByRole('heading', { name: 'Cap Rate' })).toBeInTheDocument();
    expect(within(detail).getByText('Header evidence')).toBeInTheDocument();
    expect(within(detail).getByText('Cap Rate', { selector: 'blockquote' })).toBeInTheDocument();
    expect(within(detail).getByText('p.2')).toBeInTheDocument();

    const link = await within(detail).findByRole('link', { name: 'Rent Roll Q1' });
    expect(link).toHaveAttribute('href', '/documents/doc-1/versions/docver-1');
  });

  it('an admin sees Confirm and Reject; a member sees the admin-only note instead', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
      [PROPOSED_URL]: () => jsonResponse({ docs: [proposedMeasure], count: 1 }),
    });

    renderPage();

    const detail = await detailRegion();
    expect(within(detail).getByText('Confirming measures requires an admin.')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Confirm…' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('an admin sees Confirm and Reject controls', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PROPOSED_URL]: () => jsonResponse({ docs: [proposedMeasure], count: 1 }),
    });

    renderPage();

    const detail = await detailRegion();
    expect(within(detail).getByRole('button', { name: 'Confirm…' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(
      within(detail).queryByText('Confirming measures requires an admin.'),
    ).not.toBeInTheDocument();
  });

  it('confirms through the editor dialog, posts to the confirm endpoint, and drops the row from the proposed view', async () => {
    const confirmedMeasure = {
      ...proposedMeasure,
      status: 'confirmed',
      confirmedBy: admin.email,
      confirmedAt: '2026-08-01T00:00:00.000Z',
      version: 2,
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === PROPOSED_URL) {
        return Promise.resolve(jsonResponse({ docs: [proposedMeasure], count: 1 }));
      }
      if (url === '/api/v1/measures/measure-1/confirm' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(confirmedMeasure));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Confirm…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm measure' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('No proposed measures')).toBeInTheDocument();

    const confirmCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/measures/measure-1/confirm',
    );
    expect(confirmCall).toBeDefined();
  });

  it('rejects a proposed measure via the confirmation dialog, posting an empty body, and drops it from the proposed view', async () => {
    const rejectedMeasure = { ...proposedMeasure, status: 'rejected' };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === PROPOSED_URL) {
        return Promise.resolve(jsonResponse({ docs: [proposedMeasure], count: 1 }));
      }
      if (url === '/api/v1/measures/measure-1/reject' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(rejectedMeasure));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject "Cap Rate"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject measure' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('No proposed measures')).toBeInTheDocument();

    const rejectCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/measures/measure-1/reject',
    );
    expect(rejectCall).toBeDefined();
    expect(JSON.parse((rejectCall?.[1] as RequestInit).body as string)).toEqual({});
  });

  it('switches status via the segmented control, requesting the new status and resetting paging/selection', async () => {
    const confirmedMeasure = { ...proposedMeasure, id: 'measure-2', status: 'confirmed' as const };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === PROPOSED_URL) {
        return Promise.resolve(jsonResponse({ docs: [proposedMeasure], count: 1 }));
      }
      if (url === '/api/v1/measures?status=confirmed&skip=0&limit=20') {
        return Promise.resolve(jsonResponse({ docs: [confirmedMeasure], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await within(await queueRegion()).findByText('Cap Rate');

    fireEvent.click(screen.getByRole('button', { name: 'Confirmed' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/measures?status=confirmed&skip=0&limit=20',
        ),
      ).toBe(true);
    });
  });

  it('shows a page-level error when the measures fetch fails', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PROPOSED_URL]: () => jsonResponse({ message: 'Measures are unavailable.' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Measures are unavailable.');
  });
});
