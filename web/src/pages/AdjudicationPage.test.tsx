import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAnnouncements, subscribeAnnouncements } from '../lib/announce';
import { clearSession } from '../lib/auth';
import {
  subscribePendingCountsInvalidation,
  unsubscribePendingCountsInvalidation,
} from '../lib/use-pending-counts';
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

// A valid Mongo ObjectId shape, distinct from the plain test ids above — the by-id fetch only
// fires for a `selected` value that passes `list-conflicts.request.dto.ts`'s `@IsMongoId` check.
const LINKED_CONFLICT_ID = '507f191e810c19729de860ea';

const linkedConflict = {
  ...authorityConflict,
  id: LINKED_CONFLICT_ID,
  factKey: { entity: 'Offpage Tower', metric: 'cap_rate', period: '2025-05' },
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

const PENDING_URL = '/api/v1/approvals?skip=0&limit=25&state=pending&sort=createdAt&sortDir=desc';
const CONFLICTS_URL = '/api/v1/conflicts?skip=0&limit=25&sort=createdAt&sortDir=desc';
// The conflicts kind's pending-approval probe. Left unstubbed by every other test here, which is
// the failure-open path: the marker is absent and nothing else changes.
const PENDING_PROBE_URL = '/api/v1/approvals?limit=100&state=pending';

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

// Wrapped in `#main-content`, matching `App.tsx`'s own routed-content container — the page's
// post-decision focus effect targets `#main-content h1` when the queue empties.
function renderPage(initialEntries: string[] = ['/']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <main id="main-content">
        <Routes>
          <Route path="/" element={<AdjudicationPage />} />
        </Routes>
      </main>
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
    clearAnnouncements();
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
      '/api/v1/approvals?skip=0&limit=25&state=approved&sort=createdAt&sortDir=desc';
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [APPROVED_URL]: () => jsonResponse({ docs: [approvedApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage(['/?state=approved']);

    const queue = await queueRegion();
    expect(
      await within(queue).findByText(
        'proposal 5.25 percent · rule authority · approved by admin@example.com — Evidence checks out.',
      ),
    ).toBeInTheDocument();
  });

  it('names a queue row concisely for assistive technology', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    const queue = await queueRegion();
    expect(
      await within(queue).findByRole('button', {
        name: `${pendingApproval.summary} — ${pendingApproval.state}`,
      }),
    ).toBeInTheDocument();
  });

  it('renders the queue title as a span, never a heading, inside the row button', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage(['/?kind=conflicts']);

    const queue = await queueRegion();
    const title = await within(queue).findByText('Northgate Business Park');
    expect(title.tagName).toBe('SPAN');
    expect(within(queue).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('says timed out rather than undecided for a timed-out approval', async () => {
    const timedOutApproval = { ...pendingApproval, id: 'approval-3', state: 'timed_out' };
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [timedOutApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    const queue = await queueRegion();
    expect(await within(queue).findByText(/timed out/)).toBeInTheDocument();
    expect(within(queue).queryByText(/undecided/)).not.toBeInTheDocument();
  });

  it('omits the proposal segment for a non-conflict subject', async () => {
    const nonConflictApproval = {
      ...pendingApproval,
      id: 'approval-4',
      subject: { entityType: 'Document', entityId: 'doc-1' },
    };
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [nonConflictApproval], count: 1 }),
    });

    renderPage();

    const queue = await queueRegion();
    expect(await within(queue).findByText('undecided')).toBeInTheDocument();
    expect(within(queue).queryByText(/proposal/)).not.toBeInTheDocument();
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
      '/api/v1/approvals?skip=25&limit=25&state=pending&sort=createdAt&sortDir=desc';
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 26 }),
        [PAGE2_URL]: () => jsonResponse({ docs: [page2Approval], count: 26 }),
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
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/v1/conflicts?skip=25'))).toBe(
      false,
    );
  });

  it('applies and clears the conflicts status filter, round-tripping through the URL', async () => {
    const RESOLVED_URL =
      '/api/v1/conflicts?skip=0&limit=25&status=resolved&sort=createdAt&sortDir=desc';
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

    expect(await screen.findByText('No conflicts match this filter')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === RESOLVED_URL)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));

    await within(await queueRegion()).findByText('Northgate Business Park');
    expect(fetchMock.mock.calls.some(([url]) => url === CONFLICTS_URL)).toBe(true);
  });

  it('requests the decisions state filter at once and clears the selection', async () => {
    const rejectedApproval = {
      ...pendingApproval,
      id: 'approval-9',
      state: 'rejected' as const,
      summary: 'A rejected decision.',
    };
    const REJECTED_URL =
      '/api/v1/approvals?skip=0&limit=25&state=rejected&sort=createdAt&sortDir=desc';
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
        [REJECTED_URL]: () => jsonResponse({ docs: [rejectedApproval], count: 1 }),
        '/api/v1/conflicts?ids=conflict-1': () =>
          jsonResponse({ docs: [authorityConflict], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/?selected=approval-1']);

    await within(await queueRegion()).findByText(pendingApproval.summary);

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'rejected' } });

    const queue = await queueRegion();
    await within(queue).findByText(rejectedApproval.summary);
    expect(fetchMock.mock.calls.some(([url]) => url === REJECTED_URL)).toBe(true);
    // Had `selected` not reset, the stale `approval-1` id would name no row on this page and the
    // pane would show the not-in-this-queue notice instead of the loaded row.
    expect(within(queue).getAllByRole('button')[0]).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await within(await queueRegion()).findByText(pendingApproval.summary);
    expect(fetchMock.mock.calls.some(([url]) => url === PENDING_URL)).toBe(true);
  });

  it('selects the conflict named by a deep link when it is on the loaded page', async () => {
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

  it('renders the linked conflict with a not-on-this-page notice instead of substituting the first row', async () => {
    const LINKED_URL = `/api/v1/conflicts?ids=${LINKED_CONFLICT_ID}`;
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
      [LINKED_URL]: () => jsonResponse({ docs: [linkedConflict], count: 1 }),
    });

    renderPage([`/?kind=conflicts&selected=${LINKED_CONFLICT_ID}`]);

    const detail = await detailRegion();
    expect(
      await within(detail).findByRole('heading', { name: 'Offpage Tower' }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText('Not in the list below — showing the conflict this link names.'),
    ).toBeInTheDocument();
    expect(
      within(detail).queryByRole('heading', { name: 'Northgate Business Park' }),
    ).not.toBeInTheDocument();
    expect(document.querySelectorAll('.card .card')).toHaveLength(0);
  });

  it('never nests a card inside a card for an off-page selection when the loaded page has no rows to pair with it', async () => {
    const LINKED_URL = `/api/v1/conflicts?ids=${LINKED_CONFLICT_ID}`;
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [], count: 0 }),
      [LINKED_URL]: () => jsonResponse({ docs: [linkedConflict], count: 1 }),
    });

    renderPage([`/?kind=conflicts&selected=${LINKED_CONFLICT_ID}`]);

    expect(await screen.findByRole('heading', { name: 'Offpage Tower' })).toBeInTheDocument();
    expect(document.querySelectorAll('.card .card')).toHaveLength(0);
  });

  it('says the conflict is no longer in the record when the by-id fetch returns nothing', async () => {
    const LINKED_URL = `/api/v1/conflicts?ids=${LINKED_CONFLICT_ID}`;
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
      [LINKED_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage([`/?kind=conflicts&selected=${LINKED_CONFLICT_ID}`]);

    expect(
      await screen.findByText('That conflict is no longer in the record.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the queue' })).toBeInTheDocument();
  });

  it('does not request a malformed selected id', async () => {
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/?kind=conflicts&selected=not-a-real-id']);

    expect(
      await screen.findByText('That conflict is no longer in the record.'),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('ids='))).toBe(false);
  });

  it('offers Retry when the by-id fetch fails', async () => {
    const LINKED_URL = `/api/v1/conflicts?ids=${LINKED_CONFLICT_ID}`;
    let attempts = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === CONFLICTS_URL) {
        return Promise.resolve(jsonResponse({ docs: [authorityConflict], count: 1 }));
      }
      if (url === LINKED_URL) {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? jsonResponse({ message: 'Internal error' }, 500)
            : jsonResponse({ docs: [linkedConflict], count: 1 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage([`/?kind=conflicts&selected=${LINKED_CONFLICT_ID}`]);

    expect(await screen.findByText('Internal error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await within(await detailRegion()).findByRole('heading', { name: 'Offpage Tower' }),
    ).toBeInTheDocument();
  });

  it('says a linked decision is not in this queue without issuing a request', async () => {
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

    renderPage(['/?selected=approval-missing']);

    expect(
      await screen.findByText(
        "That decision isn't in this queue. It may already be decided, or it may be on another page.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('approvals/approval-missing'))).toBe(
      false,
    );
  });

  it('drops the selection when the page is turned', async () => {
    const PAGE2_CONFLICTS_URL = '/api/v1/conflicts?skip=25&limit=25&sort=createdAt&sortDir=desc';
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 26 }),
      [PAGE2_CONFLICTS_URL]: () => jsonResponse({ docs: [recencyConflict], count: 26 }),
    });

    renderPage(['/?kind=conflicts&selected=conflict-1']);

    expect(
      await within(await detailRegion()).findByRole('heading', {
        name: 'Northgate Business Park',
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(
      await within(await detailRegion()).findByRole('heading', { name: 'Riverside Plaza' }),
    ).toBeInTheDocument();
  });

  it('marks an open conflict that already has a pending approval', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
      [PENDING_PROBE_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
    });

    renderPage(['/?kind=conflicts']);

    const detail = await detailRegion();
    expect(
      await within(detail).findByText('Resolution pending — awaiting approval.'),
    ).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: 'Open the decision' })).toHaveAttribute(
      'href',
      '/adjudication?kind=decisions&state=pending&selected=approval-1',
    );
    expect(
      within(detail).queryByRole('button', { name: 'Request resolution' }),
    ).not.toBeInTheDocument();
  });

  it('drops the pending-approval marker when a later probe fails', async () => {
    let probes = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === CONFLICTS_URL) {
        return Promise.resolve(jsonResponse({ docs: [authorityConflict], count: 1 }));
      }
      if (url === PENDING_URL) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      if (url === PENDING_PROBE_URL) {
        probes += 1;
        return Promise.resolve(
          probes === 1
            ? jsonResponse({ docs: [pendingApproval], count: 1 })
            : jsonResponse({ message: 'Internal error' }, 500),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/?kind=conflicts']);

    await screen.findByText('Resolution pending — awaiting approval.');

    fireEvent.click(screen.getByRole('button', { name: 'Decisions' }));
    await screen.findByText('Nothing waiting on you');
    fireEvent.click(screen.getByRole('button', { name: 'Conflicts' }));

    expect(await screen.findAllByRole('button', { name: 'Request resolution' })).toHaveLength(2);
    expect(screen.queryByText('Resolution pending — awaiting approval.')).not.toBeInTheDocument();
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
    // The row removal commits inside a transition, one render after the dialog closes.
    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument();

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

  it('keeps the earned-zero state off an emptied page that still has earlier pages', async () => {
    const PAGE2_URL = '/api/v1/conflicts?skip=20&limit=25&sort=createdAt&sortDir=desc';
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PAGE2_URL]: () => jsonResponse({ docs: [], count: 15 }),
    });

    renderPage(['/?kind=conflicts&skip=20']);

    await screen.findByText('Nothing on this page');
    expect(screen.queryByText('No conflicts')).not.toBeInTheDocument();
    expect(screen.queryByText('No conflicts match this filter')).not.toBeInTheDocument();
  });

  it('offers a previous-page action when the page is empty but the count is not', async () => {
    const PAGE2_URL = '/api/v1/conflicts?skip=20&limit=25&sort=createdAt&sortDir=desc';
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PAGE2_URL]: () => jsonResponse({ docs: [], count: 15 }),
        [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 15 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/?kind=conflicts&skip=20']);

    const action = await screen.findByRole('button', { name: 'Go to the previous page' });
    fireEvent.click(action);

    await within(await queueRegion()).findByText('Northgate Business Park');
    expect(fetchMock.mock.calls.some(([url]) => url === CONFLICTS_URL)).toBe(true);
  });

  it('re-syncs the filter select when the applied filter changes under a mounted page', async () => {
    const RESOLVED_URL =
      '/api/v1/conflicts?skip=0&limit=25&status=resolved&sort=createdAt&sortDir=desc';
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
      [RESOLVED_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    render(
      <MemoryRouter initialEntries={['/?kind=conflicts']}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <Link to="/?kind=conflicts&status=resolved">Sidebar link</Link>
                <AdjudicationPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await within(await queueRegion()).findByText('Northgate Business Park');
    expect(screen.getByLabelText('Status')).toHaveValue('');

    fireEvent.click(screen.getByRole('link', { name: 'Sidebar link' }));

    await screen.findByText('No conflicts match this filter');
    expect(screen.getByLabelText('Status')).toHaveValue('resolved');
  });

  it('notices a failed conflict join and retries it', async () => {
    let attempts = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === PENDING_URL) {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 1 }));
      }
      if (url === '/api/v1/conflicts?ids=conflict-1') {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? jsonResponse({ message: 'Internal error' }, 500)
            : jsonResponse({ docs: [authorityConflict], count: 1 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(
      await screen.findByText("Couldn't load the conflict behind this decision"),
    ).toBeInTheDocument();
    expect(screen.getByText('Internal error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(
        screen.queryByText("Couldn't load the conflict behind this decision"),
      ).not.toBeInTheDocument();
    });
    expect(attempts).toBe(2);
  });

  it('starts a freshly selected approval with no carried error', async () => {
    const approvalA = {
      ...pendingApproval,
      subject: { entityType: 'Measure', entityId: 'measure-1' },
    };
    const approvalB = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'A different pending decision.',
      subject: { entityType: 'Measure', entityId: 'measure-2' },
      workflowId: undefined,
    };
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [approvalA, approvalB], count: 2 }),
      '/api/v1/workflow-runs?workflowId=wf-1': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'View run' }));
    expect(
      await within(await detailRegion()).findByText('No run found for this workflow.'),
    ).toBeInTheDocument();

    const queue = await queueRegion();
    fireEvent.click(within(queue).getAllByRole('button')[1]);

    const detail = await detailRegion();
    await within(detail).findByText('A different pending decision.');
    expect(within(detail).queryByText('No run found for this workflow.')).not.toBeInTheDocument();
  });

  it('moves focus to the next queue row after a decision', async () => {
    const approvalA = {
      ...pendingApproval,
      subject: { entityType: 'Measure', entityId: 'measure-1' },
    };
    const approvalB = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'A different pending decision.',
      subject: { entityType: 'Measure', entityId: 'measure-2' },
    };
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [approvalA, approvalB], count: 2 }),
      '/api/v1/approvals/approval-1/decision': () =>
        jsonResponse({ ...approvalA, state: 'approved', decidedBy: admin.email }),
    });

    renderPage();

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const queue = await queueRegion();
    await waitFor(() => {
      expect(within(queue).getAllByRole('button')).toHaveLength(1);
    });
    // Focus lands in a passive effect keyed on the transition's focus request, which can commit a
    // render after the row count settles.
    await waitFor(() => {
      expect(within(queue).getAllByRole('button')[0]).toHaveFocus();
    });
  });

  it('moves focus to a reloaded queue row when the decision was already settled elsewhere', async () => {
    const approvalA = {
      ...pendingApproval,
      subject: { entityType: 'Measure', entityId: 'measure-1' },
    };
    const approvalB = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'A different pending decision.',
      subject: { entityType: 'Measure', entityId: 'measure-2' },
    };
    let pendingDocs = [approvalA, approvalB];
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: pendingDocs, count: pendingDocs.length }),
      '/api/v1/approvals/approval-1/decision': () => {
        pendingDocs = [approvalB];
        return jsonResponse({ message: 'Approval already decided' }, 409);
      },
    });

    renderPage();

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // The 409 reloads the page rather than removing the row locally; focus waits for that reload,
    // so it lands on the row that remains instead of the decided row the reload removes.
    const queue = await queueRegion();
    await waitFor(() => {
      expect(within(queue).getByRole('button')).toHaveFocus();
    });
  });

  it('leaves focus on the kind the user switched back to when a 409 reload was superseded', async () => {
    const approvalA = {
      ...pendingApproval,
      subject: { entityType: 'Measure', entityId: 'measure-1' },
    };
    const approvalB = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'A different pending decision.',
      subject: { entityType: 'Measure', entityId: 'measure-2' },
    };
    let pendingDocs = [approvalA, approvalB];
    let deferNextReload = false;
    let resolveStaleReload: (response: Response) => void = () => {};
    const staleReload = new Promise<Response>((resolve) => {
      resolveStaleReload = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === PENDING_URL && deferNextReload) {
        deferNextReload = false;
        return staleReload;
      }
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: pendingDocs, count: pendingDocs.length }),
        [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
        '/api/v1/approvals/approval-1/decision': () => {
          pendingDocs = [approvalB];
          deferNextReload = true;
          return jsonResponse({ message: 'Approval already decided' }, 409);
        },
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

    // The reload the 409 asked for is still in flight while the user leaves for Conflicts and
    // comes back, so the Decisions load that lands first is not the one the decision armed.
    const kinds = screen.getByRole('group', { name: 'Adjudication kind' });
    fireEvent.click(within(kinds).getByRole('button', { name: 'Conflicts' }));
    await within(await detailRegion()).findByRole('heading', { name: 'Northgate Business Park' });
    const decisions = within(kinds).getByRole('button', { name: 'Decisions' });
    decisions.focus();
    fireEvent.click(decisions);

    const queue = await queueRegion();
    await waitFor(() => {
      expect(within(queue).getAllByRole('button')).toHaveLength(1);
    });
    expect(decisions).toHaveFocus();

    resolveStaleReload(jsonResponse({ docs: pendingDocs, count: pendingDocs.length }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(decisions).toHaveFocus();
    expect(within(queue).getByRole('button')).not.toHaveFocus();
  });

  it('never reports a selected approval missing after the server says it was already settled', async () => {
    const approvalA = {
      ...pendingApproval,
      subject: { entityType: 'Measure', entityId: 'measure-1' },
    };
    const approvalB = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'A different pending decision.',
      subject: { entityType: 'Measure', entityId: 'measure-2' },
    };
    let pendingDocs = [approvalA, approvalB];
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: pendingDocs, count: pendingDocs.length }),
      '/api/v1/approvals/approval-1/decision': () => {
        pendingDocs = [approvalB];
        return jsonResponse({ message: 'Approval already decided' }, 409);
      },
    });

    renderPage(['/?selected=approval-1']);

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // The reload drops the decided approval the URL selected; the selection clears with it, so the
    // remaining row takes the pane and the focus rather than the off-page notice and the heading.
    const queue = await queueRegion();
    await waitFor(() => {
      expect(within(queue).getByRole('button')).toHaveFocus();
    });
    await within(await detailRegion()).findByText('A different pending decision.');
    expect(screen.queryByText(/That decision isn't in this queue/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Adjudication', level: 1 })).not.toHaveFocus();
  });

  it('hands a selection naming the decided approval to the next row, never reporting it missing', async () => {
    const approvalA = {
      ...pendingApproval,
      subject: { entityType: 'Measure', entityId: 'measure-1' },
    };
    const approvalB = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'A different pending decision.',
      subject: { entityType: 'Measure', entityId: 'measure-2' },
    };
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [approvalA, approvalB], count: 2 }),
      '/api/v1/approvals/approval-1/decision': () =>
        jsonResponse({ ...approvalA, state: 'approved', decidedBy: admin.email }),
    });

    renderPage(['/?selected=approval-1']);

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const queue = await queueRegion();
    await waitFor(() => {
      expect(within(queue).getAllByRole('button')).toHaveLength(1);
    });
    await within(await detailRegion()).findByText('A different pending decision.');
    expect(screen.queryByText(/That decision isn't in this queue/)).not.toBeInTheDocument();
    // Focus lands in a passive effect keyed on the transition's focus request, which can commit a
    // render after the row count settles.
    await waitFor(() => {
      expect(within(queue).getAllByRole('button')[0]).toHaveFocus();
    });
  });

  it('shows the empty inbox, not an off-page notice, after deciding the selected last approval', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
      '/api/v1/approvals/approval-1/decision': () =>
        jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
    });

    renderPage(['/?selected=approval-1']);

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument();
    expect(screen.queryByText(/That decision isn't in this queue/)).not.toBeInTheDocument();
    // Heading focus lands in the same focus-request effect as the empty state, one render after.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Adjudication', level: 1 })).toHaveFocus();
    });
  });

  it('moves focus to the page heading when the queue empties', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
      '/api/v1/approvals/approval-1/decision': () =>
        jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
    });
    const messages: string[] = [];
    subscribeAnnouncements((message) => messages.push(message));

    renderPage();

    fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.getByText('Nothing waiting on you')).toBeInTheDocument();
    });
    // Heading focus and the announcement both fire from the same focus-request effect as the empty
    // state, one render after — waiting for focus also covers the announcement, which the effect
    // fires synchronously right after `heading.focus()`.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Adjudication', level: 1 })).toHaveFocus();
    });
    expect(messages).toContain('Nothing waiting on you');
  });

  it('invalidates the pending counts after a decision', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
      '/api/v1/approvals/approval-1/decision': () =>
        jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
    });
    const listener = vi.fn();
    subscribePendingCountsInvalidation(listener);

    try {
      renderPage();

      fireEvent.click(within(await detailRegion()).getByRole('button', { name: 'Approve' }));
      const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

      await waitFor(() => {
        expect(listener).toHaveBeenCalled();
      });
    } finally {
      unsubscribePendingCountsInvalidation(listener);
    }
  });

  it('shows the open-conflict and pending-approval backlog on the kind segments', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
      '/api/v1/conflicts?limit=1&status=open': () => jsonResponse({ docs: [], count: 2 }),
      '/api/v1/approvals?limit=1&state=pending': () => jsonResponse({ docs: [], count: 1 }),
    });

    renderPage();

    await within(await queueRegion()).findByText(pendingApproval.summary);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Conflicts' })).toHaveTextContent('Conflicts (2)');
    });
    expect(screen.getByRole('button', { name: 'Decisions' })).toHaveTextContent('Decisions (1)');
  });

  it('names each filter bar for assistive technology', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
      [CONFLICTS_URL]: () => jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    await screen.findByRole('form', { name: 'Decision filters' });

    fireEvent.click(screen.getByRole('button', { name: 'Conflicts' }));

    expect(await screen.findByRole('form', { name: 'Conflict filters' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Decision filters' })).not.toBeInTheDocument();
  });

  it('renders Sort as the last control inside the named filter form', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    const form = await screen.findByRole('form', { name: 'Decision filters' });
    const controls = within(form).getAllByRole('combobox');
    expect(controls).toHaveLength(2);
    expect(controls[0]).toHaveAccessibleName('State');
    expect(controls[1]).toHaveAccessibleName('Sort');
  });

  it('clamps an out-of-range limit and a negative skip from the URL', async () => {
    const CLAMPED_URL =
      '/api/v1/approvals?skip=0&limit=25&state=pending&sort=createdAt&sortDir=desc';
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [CLAMPED_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage(['/?limit=7&skip=-1']);

    await within(await queueRegion()).findByText(pendingApproval.summary);
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage(['/?sort=bogus&sortDir=up']);

    await within(await queueRegion()).findByText(pendingApproval.summary);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Sort')).toHaveValue('createdAt-desc');
  });

  it('announces the result count on a filter change but stays silent on first load', async () => {
    const REJECTED_URL =
      '/api/v1/approvals?skip=0&limit=25&state=rejected&sort=createdAt&sortDir=desc';
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
      [REJECTED_URL]: () => jsonResponse({ docs: [], count: 0 }),
      '/api/v1/conflicts?ids=conflict-1': () =>
        jsonResponse({ docs: [authorityConflict], count: 1 }),
    });
    const messages: string[] = [];
    subscribeAnnouncements((message) => messages.push(message));

    renderPage();

    await within(await queueRegion()).findByText(pendingApproval.summary);
    expect(messages).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'rejected' } });

    await screen.findByText('No approvals match this filter');
    expect(messages).toEqual(['0 decisions']);
  });

  it('round-trips the page size through the URL and sends it as limit', async () => {
    const PAGE_SIZE_50_URL =
      '/api/v1/approvals?skip=0&limit=50&state=pending&sort=createdAt&sortDir=desc';
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        [PENDING_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
        [PAGE_SIZE_50_URL]: () => jsonResponse({ docs: [pendingApproval], count: 1 }),
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

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === PAGE_SIZE_50_URL)).toBe(true);
    });
  });
});
