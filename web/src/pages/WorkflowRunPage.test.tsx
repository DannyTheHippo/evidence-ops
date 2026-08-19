import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
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
// — otherwise whichever role the first test resolves would leak into every later one, matching
// ApprovalsPage.test.tsx's own afterEach.
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
      if (url === '/api/v1/approvals') {
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

    currentRun = completedRun;
    currentApprovals = [];

    expect(await screen.findByText('Resumed — completed')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.queryByText('Not yet resumed')).not.toBeInTheDocument();
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

    expect(screen.getByText('completed')).toBeInTheDocument();

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

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await tick(1000);
    await tick(1000);
    await tick(1000);

    expect(fetchMock.mock.calls.filter(([url]) => isRunRequest(url))).toHaveLength(4);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
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

    expect(screen.getByText('running')).toBeInTheDocument();

    await tick(1000);
    await tick(1000);

    expect(screen.getByText('Resumed — completed')).toBeInTheDocument();

    staleRun.resolve(jsonResponse(runningRun));
    await tick();

    expect(screen.getByText('Resumed — completed')).toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();
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

    act(() => {
      source.emit('run', failedRun);
    });

    expect(screen.getByText('Resumed — failed')).toBeInTheDocument();
    expect(screen.getAllByText('Retrieval service returned a 503.')).toHaveLength(2);
    expect(source.closed).toBe(true);
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

  it('lets an admin decide the blocking approval directly from the run page', async () => {
    let currentApprovals: (typeof pendingApproval)[] = [pendingApproval];
    const me = meRoute(admin);
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url === '/api/v1/approvals') {
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

  it('shows why deciding is unavailable to a non-admin, with no decide controls reachable', async () => {
    const me = meRoute(member);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const meResponse = me(input);
      if (meResponse) return meResponse;
      const url = typeof input === 'string' ? input : '';
      if (isRunRequest(input)) return Promise.resolve(jsonResponse(runningRun));
      if (url === '/api/v1/approvals') {
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
});
