import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import AdjudicationPage from './AdjudicationPage';

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

const authorityConflict = {
  id: 'conflict-1',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
  factIds: ['fact-1', 'fact-2'],
  values: [
    {
      factId: 'fact-1',
      value: 5.25,
      unit: 'percent',
      sourceChunkId: 'chunk-a',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      withdrawn: false,
    },
    {
      factId: 'fact-2',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-b',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
      withdrawn: false,
    },
  ],
  magnitude: 0.0085,
  magnitudeUnit: 'ratio',
  status: 'open',
  createdAt: '2026-08-01T11:00:00.000Z',
  stale: false,
  unscorable: false,
  proposedWinnerFactId: 'fact-1',
  ruleFired: 'authority',
  explanation: "Source 'chunk-a' outranks the other value's source under the authority policy.",
};

const recencyConflict = {
  ...authorityConflict,
  id: 'conflict-2',
  factKey: { entity: 'Riverside Plaza', metric: 'cap_rate', period: '2025-04' },
  proposedWinnerFactId: 'fact-3',
  ruleFired: 'recency',
  explanation: "Source 'chunk-c' was ingested more recently than the conflicting value's source.",
  values: [
    {
      factId: 'fact-3',
      value: 5.4,
      unit: 'percent',
      sourceChunkId: 'chunk-c',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 4 },
      withdrawn: false,
    },
  ],
};

const pendingApproval = {
  id: 'approval-1',
  subject: { entityType: 'Conflict', entityId: 'conflict-1' },
  action: 'resolve_conflict',
  summary: 'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
  requestedBy: 'analyst@example.com',
  workflowId: 'wf-1',
  state: 'pending',
  createdAt: '2026-08-01T12:00:00.000Z',
};

const approvedApproval = {
  ...pendingApproval,
  id: 'approval-2',
  state: 'approved',
  decidedBy: 'admin@example.com',
  decisionReason: 'Evidence checks out.',
  decidedAt: '2026-08-05T10:15:00.000Z',
};

const PENDING_URL = '/api/v1/approvals?skip=0&limit=20&state=pending&sort=createdAt&sortDir=desc';
const CONFLICTS_URL = '/api/v1/conflicts?skip=0&limit=20&sort=createdAt&sortDir=desc';

// Dispatches by URL so a test can mock only the endpoints it cares about, layered on the
// `/auth/me` probe `useSession()` makes and the `/api/v1/metrics` probe `useMetricLabels()` makes
// on top of every other endpoint's stub — an unstubbed route rejects, which both hooks' own
// `.catch(() => {})` absorbs, so assertions below check raw metric ids rather than a translated
// label.
function stubFetch(routes: Record<string, () => Response>): void {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(initialEntries: string[] = ['/']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<AdjudicationPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function queueRegion() {
  return screen.findByRole('region', { name: 'Adjudication queue' });
}

function detailRegion() {
  return screen.findByRole('region', { name: 'Case detail' });
}

describe('AdjudicationPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
  });

  it('defaults to the pending decisions queue, joining the referenced conflict with no second query per row', async () => {
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
        '/api/v1/conflicts?ids=conflict-1': () =>
          jsonResponse({ docs: [authorityConflict], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(screen.getByText('Loading decisions…')).toBeInTheDocument();

    const queue = await queueRegion();
    expect(within(queue).getByText(pendingApproval.summary)).toBeInTheDocument();

    const detail = await detailRegion();
    expect(within(detail).getByText(pendingApproval.summary)).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Approve' })).toBeInTheDocument();

    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/conflicts?ids=conflict-1'),
    ).toHaveLength(1);
  });

  it('renders a decision row with its proposal, the rule that fired, the decider and the reason', async () => {
    const APPROVED_URL =
      '/api/v1/approvals?skip=0&limit=20&state=approved&sort=createdAt&sortDir=desc';
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [APPROVED_URL]: () => jsonResponse({ docs: [approvedApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage(['/?state=approved']);

    const queue = await queueRegion();
    expect(
      within(queue).getByText(
        'proposal 5.25 percent · rule authority · admin@example.com — Evidence checks out.',
      ),
    ).toBeInTheDocument();
  });

  it('switches to the conflicts queue, requesting the unfiltered list and resetting skip and selected', async () => {
    // A second Document-subject approval on page two — its subject is deliberately not a
    // Conflict, so paging to it takes no second `listConflicts({ ids })` join.
    const page2Approval = {
      ...pendingApproval,
      id: 'approval-2',
      subject: { entityType: 'Document', entityId: 'doc-1' },
      summary: 'A different pending decision.',
    };
    const PAGE2_URL =
      '/api/v1/approvals?skip=20&limit=20&state=pending&sort=createdAt&sortDir=desc';
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 25 }),
        [PAGE2_URL]: () => jsonResponse({ docs: [page2Approval], count: 25 }),
        '/api/v1/conflicts?ids=conflict-1': () =>
          jsonResponse({ docs: [authorityConflict], count: 1 }),
        [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await within(await queueRegion()).findByText(pendingApproval.summary);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await within(await queueRegion()).findByText(page2Approval.summary);

    fireEvent.click(screen.getByRole('button', { name: 'Conflicts' }));

    const detail = await detailRegion();
    expect(
      await within(detail).findByRole('heading', { name: 'Northgate Business Park' }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === CONFLICTS_URL)).toBe(true);
    // Had skip/selected not reset, the fetch would have carried the page-two skip forward.
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/v1/conflicts?skip=20'))).toBe(
      false,
    );
  });

  it('applies and clears the conflicts status filter, round-tripping through the URL', async () => {
    const RESOLVED_URL =
      '/api/v1/conflicts?skip=0&limit=20&status=resolved&sort=createdAt&sortDir=desc';
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
        [RESOLVED_URL]: () => jsonResponse({ docs: [], count: 0 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/?kind=conflicts']);

    await within(await queueRegion()).findByText('Northgate Business Park');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'resolved' } });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('status=resolved'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('No conflicts match this filter')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === RESOLVED_URL)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));

    await within(await queueRegion()).findByText('Northgate Business Park');
    expect(fetchMock.mock.calls.some(([url]) => url === CONFLICTS_URL)).toBe(true);
  });

  it('applies and clears the decisions state filter, round-tripping through the URL', async () => {
    const REJECTED_URL =
      '/api/v1/approvals?skip=0&limit=20&state=rejected&sort=createdAt&sortDir=desc';
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
        [REJECTED_URL]: () => jsonResponse({ docs: [], count: 0 }),
        '/api/v1/conflicts?ids=conflict-1': () =>
          jsonResponse({ docs: [authorityConflict], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await within(await queueRegion()).findByText(pendingApproval.summary);

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'rejected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('No approvals match this filter')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === REJECTED_URL)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));

    await within(await queueRegion()).findByText(pendingApproval.summary);
    expect(fetchMock.mock.calls.some(([url]) => url === PENDING_URL)).toBe(true);
  });

  it('selects the conflict named by a deep link, and falls back to the first row for an off-page id', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict, recencyConflict], count: 2 }),
    });

    renderPage(['/?kind=conflicts&selected=conflict-2']);

    const queue = await queueRegion();
    const rows = within(queue).getAllByRole('button');
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(
      await within(await detailRegion()).findByRole('heading', { name: 'Riverside Plaza' }),
    ).toBeInTheDocument();
  });

  it('falls back to the first row when the selected id is off the loaded page', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage(['/?kind=conflicts&selected=conflict-missing']);

    expect(
      await within(await detailRegion()).findByRole('heading', {
        name: 'Northgate Business Park',
      }),
    ).toBeInTheDocument();
  });

  it('ArrowDown in the queue moves both focus and selection to the next row', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict, recencyConflict], count: 2 }),
    });

    renderPage(['/?kind=conflicts']);

    const queue = await queueRegion();
    const rows = within(queue).getAllByRole('button');
    rows[0].focus();

    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });

    expect(rows[1]).toHaveFocus();
    expect(
      await within(await detailRegion()).findByRole('heading', { name: 'Riverside Plaza' }),
    ).toBeInTheDocument();
  });

  it('deciding a pending approval removes its row and decrements the count', async () => {
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
        '/api/v1/conflicts?ids=conflict-1': () =>
          jsonResponse({ docs: [authorityConflict], count: 1 }),
        '/api/v1/approvals/approval-1/decision': () =>
          jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Nothing waiting on you')).toBeInTheDocument();

    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/approvals/approval-1/decision'),
    ).toBe(true);
  });

  it('shows the earned-zero empty state for an unfiltered conflicts queue', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage(['/?kind=conflicts']);

    const title = await screen.findByText('No conflicts');
    expect(title.closest('.empty-state--zero')).not.toBeNull();
  });

  it('shows the earned-zero empty state for an empty pending inbox', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    const title = await screen.findByText('Nothing waiting on you');
    expect(title.closest('.empty-state--zero')).not.toBeNull();
  });

  it('shows a page-level error alert on a failed fetch', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ message: 'Internal error' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal error');
  });
});
