import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import ApprovalsPage from './ApprovalsPage';

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
    },
    {
      factId: 'fact-2',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-b',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
    },
  ],
  magnitude: 0.0085,
  status: 'open',
  createdAt: '2026-08-01T11:00:00.000Z',
  proposedWinnerFactId: 'fact-1',
  ruleFired: 'authority',
  explanation: "Source 'chunk-a' outranks the other value's source under the authority policy.",
};

const recencyConflict = {
  ...authorityConflict,
  id: 'conflict-2',
  proposedWinnerFactId: 'fact-2',
  ruleFired: 'recency',
  explanation: "Source 'chunk-b' was ingested more recently than the conflicting value's source.",
};

const undecidedConflict = {
  ...authorityConflict,
  id: 'conflict-3',
  proposedWinnerFactId: undefined,
  ruleFired: 'none',
  explanation: 'No configured rule distinguishes between these sources.',
};

// Dispatches by URL so a test can mock only the endpoints it cares about, and layer the
// /auth/me probe useSession() now makes on top of every other endpoint's stub.
function stubFetch(routes: Record<string, () => Response>): void {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<ApprovalsPage />} />
        {/* Static, not :id — pins the assertion to the run's own id ('run-1'), not
            approval.workflowId ('wf-1'), so a regression to the wrong field fails the test
            instead of matching anything. */}
        <Route path="/workflow-runs/run-1" element={<p>run page probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ApprovalsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
  });

  it('lists a pending approval showing the conflicting values, source, and request timestamp', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts': () => jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(
      await screen.findByText(
        'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.getByText('Requested by analyst@example.com')).toBeInTheDocument();
    expect(
      screen.getByText(`Requested ${new Date(pendingApproval.createdAt).toLocaleString()}`),
    ).toBeInTheDocument();
  });

  it("shows the conflict's authority-rule recommendation as a suggestion, not a decision", async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts': () => jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Recommended · authority')).toBeInTheDocument();
    expect(
      screen.getByText(
        "5.25 percent — Source 'chunk-a' outranks the other value's source under the authority policy.",
      ),
    ).toBeInTheDocument();
    // The approve/reject controls stay separate, explicit actions — the recommendation never
    // pre-fills a decision or triggers one on its own.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('shows a recency-rule recommendation the same way', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({
          docs: [
            { ...pendingApproval, subject: { entityType: 'Conflict', entityId: 'conflict-2' } },
          ],
          count: 1,
        }),
      '/api/v1/conflicts': () => jsonResponse({ docs: [recencyConflict], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Recommended · recency')).toBeInTheDocument();
    expect(
      screen.getByText(
        "6.1 percent — Source 'chunk-b' was ingested more recently than the conflicting value's source.",
      ),
    ).toBeInTheDocument();
  });

  it('shows no recommendation when the policy declines to pick a winner, but still shows why', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({
          docs: [
            { ...pendingApproval, subject: { entityType: 'Conflict', entityId: 'conflict-3' } },
          ],
          count: 1,
        }),
      '/api/v1/conflicts': () => jsonResponse({ docs: [undecidedConflict], count: 1 }),
    });

    renderPage();

    expect(
      await screen.findByText(
        'Policy has no recommendation for this conflict — No configured rule distinguishes between these sources.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Recommended ·/)).not.toBeInTheDocument();
  });

  it('an admin sees the decide controls, and clicking Approve opens a dialog naming the approval', async () => {
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
          jsonResponse({ docs: [pendingApproval], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByText('Deciding approvals requires an admin.')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    expect(within(dialog).getByText(pendingApproval.summary)).toBeInTheDocument();
    // The recommendation (when present) is only ever a suggestion — loading and rendering an
    // approval, recommendation included, never itself calls the decision endpoint. Opening the
    // dialog is not deciding either.
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/approvals/approval-1/decision'),
    ).toBe(false);
  });

  it('confirming inside the dialog sends the decision with the reason and removes the approval from the inbox', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
          jsonResponse({ docs: [pendingApproval], count: 1 }),
        '/api/v1/approvals/approval-1/decision': () =>
          jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });

    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: 'Evidence checks out.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Nothing waiting on you')).toBeInTheDocument();

    const decideCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/approvals/approval-1/decision',
    );
    expect(decideCall).toBeDefined();
    expect(JSON.parse((decideCall?.[1] as RequestInit).body as string)).toEqual({
      decision: 'approved',
      reason: 'Evidence checks out.',
    });
  });

  it('rejects a pending approval via the dialog and removes it from the inbox', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === '/api/v1/approvals?skip=0&limit=20&state=pending') {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 1 }));
      }
      if (url === '/api/v1/approvals/approval-1/decision') {
        return Promise.resolve(jsonResponse({ ...pendingApproval, state: 'rejected' }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Nothing waiting on you')).toBeInTheDocument();

    const decideCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/approvals/approval-1/decision',
    );
    expect(decideCall).toBeDefined();
    expect(JSON.parse((decideCall?.[1] as RequestInit).body as string)).toEqual({
      decision: 'rejected',
    });
  });

  it('cancelling the dialog closes it without deciding, leaving the approval pending', async () => {
    const fetchMock = vi.fn((url: string) => {
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
          jsonResponse({ docs: [pendingApproval], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/approvals/approval-1/decision'),
    ).toBe(false);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('a member sees why deciding is unavailable, and cannot reach the decide controls', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({ docs: [pendingApproval], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Deciding approvals requires an admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reason (optional)')).not.toBeInTheDocument();
  });

  it('withholds the admin-only notice until the session probe resolves, then admits the admin', async () => {
    let resolveMe: (res: Response) => void;
    const pendingMe = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return pendingMe;
      if (url === '/api/v1/approvals?skip=0&limit=20&state=pending') {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 1 }));
      }
      if (url === '/api/v1/conflicts') {
        return Promise.resolve(jsonResponse({ docs: [authorityConflict], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    // Anchored on the approval itself, so the absences below are about the unresolved session
    // rather than a list that has not arrived yet.
    expect(await screen.findByText(pendingApproval.summary)).toBeInTheDocument();
    expect(screen.queryByText('Deciding approvals requires an admin.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reason (optional)')).not.toBeInTheDocument();

    resolveMe!(jsonResponse(admin));

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByText('Deciding approvals requires an admin.')).not.toBeInTheDocument();
  });

  it('shows the pager total and keeps Next enabled when the inbox is truncated', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({ docs: [pendingApproval], count: 32 }),
      '/api/v1/conflicts': () => jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('32 total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('disables Next once the full inbox fits on the page', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/conflicts': () => jsonResponse({ docs: [authorityConflict], count: 1 }),
    });

    renderPage();

    await screen.findByText(pendingApproval.summary);
    expect(screen.getByText('1 total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('pages past the first 20 approvals, sending skip/limit and the applied state', async () => {
    const otherPageApproval = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'Resolve a different conflict entirely.',
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === '/api/v1/approvals?skip=20&limit=20&state=pending') {
        return Promise.resolve(jsonResponse({ docs: [otherPageApproval], count: 25 }));
      }
      if (url === '/api/v1/approvals?skip=0&limit=20&state=pending') {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 25 }));
      }
      if (url === '/api/v1/conflicts') {
        return Promise.resolve(jsonResponse({ docs: [authorityConflict], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByText(pendingApproval.summary);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText(otherPageApproval.summary)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/approvals?skip=20&limit=20&state=pending',
      ),
    ).toBe(true);
  });

  it('applies the state filter on submit, resets paging, and offers no "All states" option', async () => {
    const page2PendingApproval = {
      ...pendingApproval,
      id: 'approval-2',
      summary: 'Resolve a different conflict entirely.',
    };
    const approvedApproval = {
      ...pendingApproval,
      id: 'approval-3',
      state: 'approved' as const,
      decidedBy: 'reviewer@example.com',
      decidedAt: '2026-08-05T10:15:00.000Z',
      decisionReason: 'Evidence checks out.',
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(admin));
      if (url === '/api/v1/approvals?skip=20&limit=20&state=pending') {
        return Promise.resolve(jsonResponse({ docs: [page2PendingApproval], count: 25 }));
      }
      if (url === '/api/v1/approvals?skip=0&limit=20&state=pending') {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 25 }));
      }
      if (url === '/api/v1/approvals?skip=0&limit=20&state=approved') {
        return Promise.resolve(jsonResponse({ docs: [approvedApproval], count: 1 }));
      }
      if (url === '/api/v1/conflicts') {
        return Promise.resolve(jsonResponse({ docs: [authorityConflict], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByText(pendingApproval.summary);
    // No "All states" entry — every option is a state the server can actually filter on
    // (approvals.service.ts's `peekPending` substitutes `pending` for an omitted param, so an
    // "all" option would silently mean "pending").
    expect(screen.queryByRole('option', { name: /all states/i })).not.toBeInTheDocument();

    // Advance to page 2 first, so the filter submit below is what proves skip resets to 0. Waits
    // on page 2's own distinct row, not just the shared "25 total" count, so the assertion below
    // cannot race ahead of the page-2 fetch actually resolving.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(page2PendingApproval.summary);

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'approved' } });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('state=approved'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText(approvedApproval.summary)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/approvals?skip=0&limit=20&state=approved',
      ),
    ).toBe(true);
    // An already-decided approval shows no decide controls — deciding it would only 409.
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    // The decision itself — who, when, and why — is read back rather than collected and discarded.
    expect(
      screen.getByText(
        `Decided ${new Date(approvedApproval.decidedAt).toLocaleString()} by reviewer@example.com`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reason: Evidence checks out.')).toBeInTheDocument();
  });

  it('navigates to the workflow run when "View run" finds one', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/workflow-runs?workflowId=wf-1': () =>
        jsonResponse({
          docs: [
            {
              id: 'run-1',
              workflowId: 'wf-1',
              status: 'running',
              createdAt: pendingApproval.createdAt,
            },
          ],
          count: 1,
        }),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'View run' }));

    expect(await screen.findByText('run page probe')).toBeInTheDocument();
  });

  it('shows an error when "View run" finds no run for the workflow', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/approvals?skip=0&limit=20&state=pending': () =>
        jsonResponse({ docs: [pendingApproval], count: 1 }),
      '/api/v1/workflow-runs?workflowId=wf-1': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'View run' }));

    expect(await screen.findByText('No run found for this workflow.')).toBeInTheDocument();
  });
});
