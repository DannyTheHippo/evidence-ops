import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, getToasts } from '../components/ui/toast';
import { subscribeAnnouncements, unsubscribeAnnouncements } from '../lib/announce';
import { clearSession } from '../lib/auth';
import { formatRelativeTimestamp } from '../lib/format-timestamp';
import { FakeEventSource } from '../test/fake-event-source';
import WorkflowRunPage from './WorkflowRunPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isRunRequest(input: RequestInfo | URL): boolean {
  return typeof input === 'string' && input.includes('/workflow-runs/');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Drives the fake clock and lets each fetch settle through its response-parsing promise chain,
// so assertions read committed state instead of racing it.
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const runningRun = {
  id: 'run-1',
  workflowId: 'wf-1',
  status: 'running',
  createdAt: new Date().toISOString(),
};

const completedRun = { ...runningRun, status: 'completed' };

const failedRun = {
  ...runningRun,
  status: 'failed',
  errorMessage: 'Retrieval service returned a 503.',
};

const pendingApproval = {
  id: 'approval-1',
  subject: { entityType: 'Conflict', entityId: 'conflict-1' },
  action: 'resolve_conflict',
  summary: 'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
  requestedBy: 'analyst@example.com',
  workflowId: 'wf-1',
  state: 'pending' as const,
  createdAt: new Date().toISOString(),
};

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

function renderAt(id: string, pollIntervalMs = 5) {
  render(
    <MemoryRouter initialEntries={[`/workflow-runs/${id}`]}>
      <Routes>
        <Route
          path="/workflow-runs/:id"
          element={<WorkflowRunPage pollIntervalMs={pollIntervalMs} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

// Every test now probes /auth/me (the decide-from-run-page path added a useSession() call), so
// dispatch by URL rather than call order, and clear the module-scope session cache between tests
// — otherwise whichever role the first test resolves would leak into every later one.
function meRoute(me: typeof admin | typeof member) {
  return (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : '';
    return url === '/api/v1/auth/me' ? Promise.resolve(jsonResponse(me)) : null;
  };
}

describe('WorkflowRunPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearSession();
    clearToasts();
  });

  it('shows the run paused awaiting approval, then resumed once the run completes', async () => {
    let currentRun: typeof runningRun | typeof completedRun = runningRun;
    let currentApprovals: (typeof pendingApproval)[] = [pendingApproval];
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(currentRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(
          jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(screen.getByText('Loading run timeline…')).toBeInTheDocument();

    expect(await screen.findByText('Paused — awaiting approval')).toBeInTheDocument();
    expect(screen.queryByText('Loading run timeline…')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Not yet resumed')).toBeInTheDocument();

    // jsdom has no EventSource in this test, so the connection chip reads the fallback transport
    // by name while the run is still in flight.
    expect(screen.getByText('Polling')).toBeInTheDocument();

    // The id stays on screen shortened, with the full value recoverable through the Tooltip,
    // which keyboard focus on the id also opens.
    expect(screen.getByText('wf-1')).toHaveAttribute('tabindex', '0');
    // No claim of live-to-the-second status, given the API's own 15s cache on this field.
    expect(
      screen.getByText('Status refreshes periodically and may lag the live run.'),
    ).toBeInTheDocument();

    const [startedStep, pausedStep, resumedStep] = screen.getAllByRole('listitem');
    expect(
      within(startedStep).getByText(formatRelativeTimestamp(runningRun.createdAt)),
    ).toBeInTheDocument();
    expect(
      within(pausedStep).getByText(formatRelativeTimestamp(pendingApproval.createdAt)),
    ).toBeInTheDocument();

    currentRun = completedRun;
    currentApprovals = [];

    expect(await screen.findByText('Finished')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Not yet resumed')).not.toBeInTheDocument();
    // This run resumed by a decision made outside this browser tab — `listApprovals()` never
    // hands back a decided approval, so there is no `decidedAt` this page could show.
    expect(within(resumedStep).getByText('Time not recorded')).toBeInTheDocument();
    // The chip hides once the run is terminal — nothing left to name a transport for.
    expect(screen.queryByText('Polling')).not.toBeInTheDocument();
  });

  it('stops polling once the run reaches a terminal status', async () => {
    vi.useFakeTimers();
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(completedRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    expect(screen.getByText('Completed')).toBeInTheDocument();

    await tick(3000);

    // Filtered to run-fetch calls specifically — the `/auth/me` probe adds one call the original
    // fixed count never accounted for, so a raw total would be a magic number bumped by trial.
    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url))).toHaveLength(1);
  });

  it('keeps a single polling interval across ticks that repeat the same status', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(runningRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    // `runningRun` carries neither `subjectId` nor `subjectType` — the cross-link to a conflict
    // never renders without a target to guess.
    expect(screen.queryByRole('link', { name: 'View conflict' })).not.toBeInTheDocument();

    // The gate now polls while `runStatus` is still undefined, so the first tick's own status
    // update tears down that interval and starts a second — one interval per distinct status, not
    // one per tick, still holds; there are just two distinct statuses crossed here (none, then
    // `running`) instead of one.
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);

    await tick(1000);
    await tick(1000);
    await tick(1000);

    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url))).toHaveLength(4);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('ignores a poll response that resolves after the run reached a terminal status', async () => {
    vi.useFakeTimers();
    const staleRun = deferred<Response>();
    const runResponses: Promise<Response>[] = [
      Promise.resolve(jsonResponse(runningRun)),
      staleRun.promise,
      Promise.resolve(jsonResponse(completedRun)),
    ];
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      if (!isRunRequest(input)) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return runResponses.shift() ?? Promise.resolve(jsonResponse(completedRun));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    expect(screen.getByText('Running')).toBeInTheDocument();

    await tick(1000);
    await tick(1000);

    expect(screen.getByText('Finished')).toBeInTheDocument();

    staleRun.resolve(jsonResponse(runningRun));
    await tick();

    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
  });

  it('drives its state entirely off the SSE stream and closes the connection on a terminal run event', () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const meResponse = me(input);
        if (meResponse) return meResponse;
        const url = typeof input === 'string' ? input : '';
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      }),
    );

    renderAt('run-1');

    expect(screen.getByText('Loading run timeline…')).toBeInTheDocument();

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('run', runningRun);
      source.emit('approvals', { docs: [pendingApproval], count: 1 });
    });

    expect(screen.getByText('Paused — awaiting approval')).toBeInTheDocument();
    expect(source.closed).toBe(false);
    // The connection chip names the transport, never the data — a live SSE frame reads the
    // shared vocabulary's own word for it, "Live".
    expect(screen.getByText('Live')).toBeInTheDocument();

    act(() => {
      source.emit('run', failedRun);
    });

    // "Failed" now names both the status badge and the final step — scope to the step so the
    // assertion is unambiguous about which one it's checking.
    const [, , finalStep] = screen.getAllByRole('listitem');
    expect(within(finalStep).getByText('Failed')).toBeInTheDocument();
    // Rendered once, at the page level — not a second time on the step that failed.
    expect(screen.getAllByText('Retrieval service returned a 503.')).toHaveLength(1);
    expect(source.closed).toBe(true);
    // The chip hides once the run is terminal, in either of its two names.
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.queryByText('Polling')).not.toBeInTheDocument();
  });

  it('shows a two-step timeline for a sync-source run, with no approval step', async () => {
    const syncRunningRun = {
      id: 'run-4',
      workflowId: 'wf-4',
      workflowType: 'sync-source' as const,
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(syncRunningRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-4');

    expect(await screen.findByText('Syncing')).toBeInTheDocument();
    expect(screen.getByText('Started')).toBeInTheDocument();
    expect(screen.queryByText('Awaiting approval')).not.toBeInTheDocument();
    expect(screen.queryByText('Paused — awaiting approval')).not.toBeInTheDocument();
    expect(screen.queryByText('Not yet resumed')).not.toBeInTheDocument();
  });

  it('links to the conflict a resolve-conflict run acted on, once the run carries a subject', async () => {
    const runWithSubject = {
      ...runningRun,
      workflowType: 'resolve-conflict' as const,
      subjectId: 'conflict-1',
      subjectType: 'Conflict',
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(runWithSubject) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByRole('link', { name: 'View conflict' })).toHaveAttribute(
      'href',
      '/adjudication?kind=conflicts&selected=conflict-1',
    );
  });

  it('links to the source a sync-source run acted on, once the run carries a subject', async () => {
    const runWithSubject = {
      ...runningRun,
      workflowType: 'sync-source' as const,
      subjectId: 'source-1',
      subjectType: 'Source',
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(runWithSubject) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByRole('link', { name: 'View source' })).toHaveAttribute(
      'href',
      '/sources/source-1',
    );
  });

  it('links to the answer a question run produced, once the run carries a subject', async () => {
    const runWithSubject = {
      ...runningRun,
      workflowType: 'answer-question' as const,
      subjectId: 'answer-1',
      subjectType: 'Answer',
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(runWithSubject) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByRole('link', { name: 'View answer' })).toHaveAttribute(
      'href',
      '/answers/answer-1',
    );
  });

  it('links to the document version an ingest run produced, once the lookup resolves', async () => {
    const runWithSubject = {
      ...runningRun,
      workflowType: 'ingest-document-version' as const,
      subjectId: 'version-1',
      subjectType: 'DocumentVersion',
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runWithSubject));
      if (url.startsWith('/api/v1/documents/versions/lookup')) {
        return Promise.resolve(
          jsonResponse({
            docs: [
              {
                versionId: 'version-1',
                documentId: 'doc-1',
                documentTitle: 'Q3 Rent Roll',
                withdrawn: false,
              },
            ],
            count: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByRole('link', { name: 'View document version' })).toHaveAttribute(
      'href',
      '/documents/doc-1/versions/version-1',
    );
  });

  it('renders no subject link for a subject type it cannot route', async () => {
    const runWithSubject = {
      ...runningRun,
      workflowType: 'sync-source' as const,
      subjectId: 'thing-1',
      subjectType: 'SomethingElse',
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(runWithSubject) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Syncing')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^View/ })).not.toBeInTheDocument();
  });

  it('shows who decided a resolve-conflict run opened after it finished', async () => {
    const decidedRun = {
      ...completedRun,
      workflowType: 'resolve-conflict' as const,
      outcome: 'resolved' as const,
    };
    const historicalApproval = {
      ...pendingApproval,
      state: 'approved' as const,
      decidedBy: admin.email,
      decidedAt: new Date().toISOString(),
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(decidedRun));
      if (url.startsWith('/api/v1/approvals?')) {
        // This tab's own poll (`state=pending`) never watched the run pause; the decided-approval
        // fetch (`state=approved`, per `outcome: 'resolved'`) is the only source for who decided it.
        if (url.includes('state=pending')) {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        return Promise.resolve(jsonResponse({ docs: [historicalApproval], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    const decidedByLine = await screen.findByText(`Decided by ${admin.email}`);
    const approvalStep = decidedByLine.closest('li');
    expect(approvalStep).not.toBeNull();
    expect(
      within(approvalStep!).getByText(formatRelativeTimestamp(historicalApproval.decidedAt)),
    ).toBeInTheDocument();
  });

  it('moves focus to the approval step after a decision, not to document.body', async () => {
    let currentApprovals: (typeof pendingApproval)[] = [pendingApproval];
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(
          jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
        );
      }
      if (url === '/api/v1/approvals/approval-1/decision') {
        currentApprovals = [];
        return Promise.resolve(
          jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // The run is still in flight, so the approval step already reads its decided-but-not-terminal
    // label — showing it here keeps the step from looking like the decision never took effect.
    const approvalStep = (await screen.findByText('Approval decided')).closest('li');
    expect(approvalStep).not.toBeNull();
    await waitFor(() => expect(approvalStep).toHaveFocus());
  });

  it('lets an admin decide the blocking approval directly from the run page', async () => {
    let currentApprovals: (typeof pendingApproval)[] = [pendingApproval];
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(
          jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
        );
      }
      if (url === '/api/v1/approvals/approval-1/decision') {
        currentApprovals = [];
        return Promise.resolve(
          jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: 'Evidence checks out.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(pendingApproval.summary)).not.toBeInTheDocument();

    const decideCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/approvals/approval-1/decision',
    );
    expect(decideCall).toBeDefined();
    expect(JSON.parse((decideCall?.[1] as RequestInit).body as string)).toEqual({
      decision: 'approved',
      reason: 'Evidence checks out.',
    });
  });

  it('shows the real decision time once the run resumes, when this tab decided it', async () => {
    let currentRun: typeof runningRun | typeof completedRun = runningRun;
    let currentApprovals: (typeof pendingApproval)[] = [pendingApproval];
    const decidedApproval = {
      ...pendingApproval,
      state: 'approved' as const,
      decidedBy: admin.email,
      decidedAt: new Date().toISOString(),
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(currentRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(
          jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
        );
      }
      if (url === '/api/v1/approvals/approval-1/decision') {
        currentApprovals = [];
        // The workflow resumes off the approval signal; the next poll picks up the terminal run.
        currentRun = completedRun;
        return Promise.resolve(jsonResponse(decidedApproval));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(await screen.findByText('Finished')).toBeInTheDocument();
    const [, , resumedStep] = screen.getAllByRole('listitem');
    expect(
      within(resumedStep).getByText(formatRelativeTimestamp(decidedApproval.decidedAt)),
    ).toBeInTheDocument();
  });

  it('guards the extracted dialog against a double submit on this page too', async () => {
    let currentApprovals: (typeof pendingApproval)[] = [pendingApproval];
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(
          jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
        );
      }
      if (url === '/api/v1/approvals/approval-1/decision') {
        currentApprovals = [];
        return Promise.resolve(
          jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: admin.email }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    const confirmButton = within(dialog).getByRole('button', { name: 'Approve' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/approvals/approval-1/decision'),
    ).toHaveLength(1);
  });

  it('shows why deciding is unavailable to a non-admin, with no decide controls reachable', async () => {
    const me = meRoute(member);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Deciding approvals requires an admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('shows "Workflow run not found" for a 404, not the generic error', async () => {
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      if (isRunRequest(input)) {
        return Promise.resolve(jsonResponse({ message: "Workflow run 'run-1' not found" }, 404));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Workflow run not found')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never reads the approvals inbox for a run type that cannot park', async () => {
    const syncRunningRun = {
      id: 'run-4',
      workflowId: 'wf-4',
      workflowType: 'sync-source' as const,
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(syncRunningRun));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-4');

    expect(await screen.findByText('Syncing')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => typeof input === 'string' && input.startsWith('/api/v1/approvals'),
      ),
    ).toBe(false);
  });

  it('scopes the pending-approval poll to this run', async () => {
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument();

    const approvalsCall = fetchMock.mock.calls.find(
      ([input]) => typeof input === 'string' && input.startsWith('/api/v1/approvals?'),
    );
    expect(approvalsCall).toBeDefined();
    const approvalsUrl = approvalsCall?.[0] as string;
    expect(approvalsUrl).toContain(`workflowId=${runningRun.workflowId}`);
    expect(approvalsUrl).toContain('state=pending');
    expect(approvalsUrl).toContain('limit=1');
  });

  it('starts polling when the first fetch failed and the stream is stale', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      // Every run fetch keeps failing, so the only observable evidence of polling is that this
      // mock keeps getting called — a run that never loads must not stop the retry.
      if (isRunRequest(input)) return Promise.reject(new Error('Network blip'));
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    // No frame has ever arrived and no fallback has been declared yet: the gate must not be
    // polling off a bare 'connecting' state.
    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url))).toHaveLength(0);

    // Advance past STALE_AFTER_MS (35s) with no frame: the stream moves connecting → stale.
    await tick(35_000);
    await tick(1_000);

    const afterStale = fetchMock.mock.calls.filter(([url]) => isRunRequest(url)).length;
    expect(afterStale).toBeGreaterThan(0);

    await tick(1_000);

    // The interval keeps retrying past the first failure rather than giving up on it.
    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url)).length).toBeGreaterThan(
      afterStale,
    );
  });

  it('retries the failed fetch through the page-level Alert', async () => {
    const me = meRoute(admin);
    let shouldFail = true;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) {
        if (shouldFail) return Promise.reject(new Error('Network blip'));
        return Promise.resolve(jsonResponse(runningRun));
      }
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Network blip');

    shouldFail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes the decision dialog when its approval is decided elsewhere', async () => {
    let currentApprovals: (typeof pendingApproval)[] = [pendingApproval];
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url.startsWith('/api/v1/approvals?')) {
        return Promise.resolve(
          jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('dialog', { name: 'Approve this approval' })).toBeInTheDocument();

    // Decided by another admin, in another tab: the next poll's approvals list comes back empty
    // without this tab ever calling `decideApproval` itself.
    currentApprovals = [];

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(getToasts()).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: 'This approval was already decided.',
      }),
    );
  });

  it('marks the current step aria-current="step", and no step once the run is terminal', async () => {
    let currentRun: typeof runningRun | typeof completedRun = runningRun;
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(currentRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    const awaitingStep = (await screen.findByText('Awaiting approval')).closest('li');
    expect(awaitingStep).toHaveAttribute('aria-current', 'step');

    currentRun = completedRun;

    expect(await screen.findByText('Finished')).toBeInTheDocument();
    for (const step of screen.getAllByRole('listitem')) {
      expect(step).not.toHaveAttribute('aria-current');
    }
  });

  it('gives a reached step its sr-only state prefix, spoken ahead of the visible label', async () => {
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(runningRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    const startedStep = (await screen.findByText('Started')).closest('li');
    expect(startedStep).not.toBeNull();
    expect(within(startedStep!).getByText('Completed:', { exact: false })).toBeInTheDocument();
  });

  it('shows a resolved resolve-conflict run as Approval granted, and Resolved on the final step', async () => {
    const resolvedRun = {
      ...completedRun,
      workflowType: 'resolve-conflict' as const,
      outcome: 'resolved' as const,
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(resolvedRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Approval granted')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('shows a rejected resolve-conflict run as Approval refused, and Rejected on the final step', async () => {
    const rejectedRun = {
      ...completedRun,
      workflowType: 'resolve-conflict' as const,
      outcome: 'rejected' as const,
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(rejectedRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Approval refused')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
  });

  it('shows a timed-out resolve-conflict run as Approval expired, and Approval timed out on the final step', async () => {
    const timedOutRun = {
      ...completedRun,
      workflowType: 'resolve-conflict' as const,
      outcome: 'timed_out' as const,
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(timedOutRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Approval expired')).toBeInTheDocument();
    expect(screen.getByText('Approval timed out')).toBeInTheDocument();
  });

  it('shows the two-step work label for an in-flight answer-question run', async () => {
    const answeringRun = { ...runningRun, workflowType: 'answer-question' as const };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(answeringRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('Answering')).toBeInTheDocument();
  });

  it('shows "No approval requested" for a completed ingest run with no outcome', async () => {
    const ingestRun = { ...completedRun, workflowType: 'ingest-document-version' as const };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(ingestRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(await screen.findByText('No approval requested')).toBeInTheDocument();
    expect(screen.getByText('Finished')).toBeInTheDocument();
  });

  it('announces a newly-pending approval and a run reaching terminal, never a state already true on open', async () => {
    vi.useFakeTimers();
    let currentRun: typeof runningRun | typeof completedRun = runningRun;
    let currentApprovals: (typeof pendingApproval)[] = [];
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input)
          ? jsonResponse(currentRun)
          : jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const listener = vi.fn();
    subscribeAnnouncements(listener);

    try {
      renderAt('run-1', 1000);
      await tick();

      // Nothing to announce yet — this mount's own first load, not a transition.
      expect(listener).not.toHaveBeenCalled();

      currentApprovals = [pendingApproval];
      await tick(1000);

      expect(listener).toHaveBeenCalledWith(
        'Approval pending — this run is waiting on a decision.',
      );

      currentApprovals = [];
      currentRun = completedRun;
      await tick(1000);

      expect(listener).toHaveBeenCalledWith('Run finished: Finished.');
      expect(
        listener.mock.calls.filter(
          ([message]) => message === 'Approval pending — this run is waiting on a decision.',
        ),
      ).toHaveLength(1);
    } finally {
      unsubscribeAnnouncements(listener);
    }
  });

  it('never announces an approval already pending when the run and its approvals first load', async () => {
    vi.useFakeTimers();
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input)
          ? jsonResponse(runningRun)
          : jsonResponse({ docs: [pendingApproval], count: 1 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const listener = vi.fn();
    subscribeAnnouncements(listener);

    try {
      renderAt('run-1', 1000);
      await tick();
      await tick(1000);

      expect(screen.getByText('Paused — awaiting approval')).toBeInTheDocument();
      expect(listener).not.toHaveBeenCalledWith(
        'Approval pending — this run is waiting on a decision.',
      );
    } finally {
      unsubscribeAnnouncements(listener);
    }
  });

  it('never announces a run already stale when its first fetch arrives', async () => {
    vi.useFakeTimers();
    const staleRun = { ...runningRun, stale: true };
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(staleRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const listener = vi.fn();
    subscribeAnnouncements(listener);

    try {
      renderAt('run-1', 1000);
      await tick();

      expect(screen.getByText(/out of date/i)).toBeInTheDocument();
      expect(listener).not.toHaveBeenCalledWith(
        'This run record is out of date and will not change further.',
      );
    } finally {
      unsubscribeAnnouncements(listener);
    }
  });

  it('announces a live run turning stale exactly once', async () => {
    vi.useFakeTimers();
    let currentRun: typeof runningRun & { stale?: boolean } = runningRun;
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(currentRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const listener = vi.fn();
    subscribeAnnouncements(listener);

    try {
      renderAt('run-1', 1000);
      await tick();

      expect(listener).not.toHaveBeenCalled();

      currentRun = { ...runningRun, stale: true };
      await tick(1000);
      await tick(3000);

      expect(screen.getByText(/out of date/i)).toBeInTheDocument();
      expect(
        listener.mock.calls.filter(
          ([message]) => message === 'This run record is out of date and will not change further.',
        ),
      ).toHaveLength(1);
    } finally {
      unsubscribeAnnouncements(listener);
    }
  });

  it('starts polling on a stale stream and shows the stale connection state', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(runningRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('run', runningRun);
    });
    expect(screen.getByText('Live')).toBeInTheDocument();

    // No named frame for STALE_AFTER_MS (35s): the stream declares itself stale, which the
    // polling gate treats the same as `reconnecting`/`fallback`.
    await tick(35_000);

    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('shows the stale-run notice, hides the live approval labels and controls, and closes the stream once the run is reported stale', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const meResponse = me(input);
        if (meResponse) return meResponse;
        const url = typeof input === 'string' ? input : '';
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      }),
    );

    renderAt('run-1');

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('run', runningRun);
      source.emit('approvals', { docs: [pendingApproval], count: 1 });
    });

    expect(screen.getByText('Paused — awaiting approval')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();

    act(() => {
      source.emit('run', { ...runningRun, stale: true });
    });

    expect(screen.getByText(/out of date/i)).toBeInTheDocument();
    expect(screen.getAllByText('Status unknown')).toHaveLength(2);
    expect(screen.queryByText('Paused — awaiting approval')).not.toBeInTheDocument();
    expect(screen.queryByText('Not yet resumed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Status refreshes periodically and may lag the live run.'),
    ).not.toBeInTheDocument();
    for (const step of screen.getAllByRole('listitem')) {
      expect(step).not.toHaveAttribute('aria-current');
    }
    // A stale run event closes the connection like a terminal one — the engine has lost this
    // workflow, so nothing further would ever arrive for it.
    expect(source.closed).toBe(true);
  });

  it('stops polling once the run is reported stale', async () => {
    vi.useFakeTimers();
    const me = meRoute(admin);
    const staleRun = { ...runningRun, stale: true };
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(staleRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    expect(screen.getByText(/out of date/i)).toBeInTheDocument();

    await tick(3000);

    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url))).toHaveLength(1);
  });

  it('tears the stream down for good once a stale run arrives through the post-fallback fetch, with no reconnect on the fallback timer', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    const staleRun = { ...runningRun, stale: true };
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(staleRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    // A hard transport failure (readyState CLOSED before the browser's error event) drops straight
    // to fallback, which refetches the run once — this is the fetch that comes back stale.
    const [source] = FakeEventSource.instances;
    act(() => {
      source.failConnection();
    });
    await tick();

    expect(screen.getByText(/out of date/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url))).toHaveLength(1);
    expect(screen.queryByText('Polling')).not.toBeInTheDocument();
    expect(screen.queryByText('Idle')).not.toBeInTheDocument();

    // A tab turning visible or the network coming back reestablishes a stream sitting in fallback —
    // neither may reopen one for a run already known stale.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });
    await tick();

    expect(FakeEventSource.instances).toHaveLength(1);

    // The fallback loop's own 30s reestablish timer, fired twice, must never reconnect or refetch
    // once the run itself is known stale.
    await tick(30_000);
    await tick(30_000);

    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url))).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('closes an idle decision dialog the moment the run turns stale', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('run', runningRun);
      source.emit('approvals', { docs: [pendingApproval], count: 1 });
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('dialog', { name: 'Approve this approval' })).toBeInTheDocument();

    act(() => {
      source.emit('run', { ...runningRun, stale: true });
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('holds the dialog open through a submit in flight when the run turns stale, then toasts its failure', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    const decidePromise = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (url === '/api/v1/approvals/approval-1/decision') return decidePromise.promise;
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    const [source] = FakeEventSource.instances;
    act(() => {
      source.emit('run', runningRun);
      source.emit('approvals', { docs: [pendingApproval], count: 1 });
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/v1/approvals/approval-1/decision'),
      ).toBe(true);
    });

    act(() => {
      source.emit('run', { ...runningRun, stale: true });
    });

    expect(screen.getByRole('dialog', { name: 'Approve this approval' })).toBeInTheDocument();

    // `decideApproval` rejects with the server's 502 once the approval signal cannot reach the
    // workflow.
    await act(async () => {
      decidePromise.resolve(
        jsonResponse({ message: 'The workflow engine did not accept the approval signal.' }, 502),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getToasts()).toContainEqual(
        expect.objectContaining({
          kind: 'error',
          message: 'The workflow engine did not accept the approval signal.',
        }),
      );
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never claims the workflow resumes for a decision that succeeds after the run turned stale', async () => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    const decidePromise = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (url === '/api/v1/approvals/approval-1/decision') return decidePromise.promise;
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const listener = vi.fn();
    subscribeAnnouncements(listener);

    try {
      renderAt('run-1');

      const [source] = FakeEventSource.instances;
      act(() => {
        source.emit('run', runningRun);
        source.emit('approvals', { docs: [pendingApproval], count: 1 });
      });

      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([url]) => url === '/api/v1/approvals/approval-1/decision'),
        ).toBe(true);
      });

      act(() => {
        source.emit('run', { ...runningRun, stale: true });
      });

      expect(screen.getByRole('dialog', { name: 'Approve this approval' })).toBeInTheDocument();

      await act(async () => {
        decidePromise.resolve(
          jsonResponse({
            ...pendingApproval,
            state: 'approved',
            decidedBy: admin.email,
            decidedAt: new Date().toISOString(),
          }),
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(getToasts()).toContainEqual(
        expect.objectContaining({ kind: 'success', message: 'Approved — decision recorded.' }),
      );
      expect(getToasts()).not.toContainEqual(
        expect.objectContaining({ message: 'Approved — the workflow resumes.' }),
      );
      expect(listener).not.toHaveBeenCalledWith('Approval recorded — the workflow resumes.');
    } finally {
      unsubscribeAnnouncements(listener);
    }
  });

  it('never announces "Approval pending" when a run turns paused and stale in the same update', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const me = meRoute(admin);
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const listener = vi.fn();
    subscribeAnnouncements(listener);

    try {
      renderAt('run-1', 1000);
      await tick();

      const [source] = FakeEventSource.instances;
      // The first frame pair carrying both a run and its approvals seeds the pause-tracking ref at
      // `false` on a live, unpaused run — so the assertion below exercises the observed-transition
      // branch, not the seed that stays silent for a state already true on first load.
      act(() => {
        source.emit('run', runningRun);
        source.emit('approvals', { docs: [], count: 0 });
      });
      await tick();

      act(() => {
        source.emit('approvals', { docs: [pendingApproval], count: 1 });
        source.emit('run', { ...runningRun, stale: true });
      });

      expect(screen.getByText(/out of date/i)).toBeInTheDocument();
      expect(listener).not.toHaveBeenCalledWith(
        'Approval pending — this run is waiting on a decision.',
      );
    } finally {
      unsubscribeAnnouncements(listener);
    }
  });

  it('shows the stale-run notice on a two-step run, with the work step reading unknown', async () => {
    const staleSyncRun = {
      id: 'run-4',
      workflowId: 'wf-4',
      workflowType: 'sync-source' as const,
      status: 'running',
      stale: true,
      createdAt: new Date().toISOString(),
    };
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      return Promise.resolve(
        isRunRequest(input) ? jsonResponse(staleSyncRun) : jsonResponse({ docs: [], count: 0 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-4');

    expect(await screen.findByText(/out of date/i)).toBeInTheDocument();
    expect(screen.getByText('Status unknown')).toBeInTheDocument();
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Status refreshes periodically and may lag the live run.'),
    ).not.toBeInTheDocument();
    for (const step of screen.getAllByRole('listitem')) {
      expect(step).not.toHaveAttribute('aria-current');
    }
  });
});
