import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  state: 'pending',
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

describe('WorkflowRunPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the run paused awaiting approval, then resumed once the run completes', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(runningRun));
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [pendingApproval], count: 1 }));
    fetchMock.mockResolvedValueOnce(jsonResponse(completedRun));
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [], count: 0 }));
    fetchMock.mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(await screen.findByText('Paused — awaiting approval')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Not yet resumed')).toBeInTheDocument();

    expect(await screen.findByText('Resumed — completed')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.queryByText('Not yet resumed')).not.toBeInTheDocument();
  });

  it('stops polling once the run reaches a terminal status', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(jsonResponse(completedRun));
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    expect(screen.getByText('completed')).toBeInTheDocument();

    await tick(3000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a single polling interval across ticks that repeat the same status', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        isRunRequest(input) ? jsonResponse(runningRun) : jsonResponse({ docs: [], count: 0 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1', 1000);
    await tick();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await tick(1000);
    await tick(1000);
    await tick(1000);

    expect(fetchMock).toHaveBeenCalledTimes(8);
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
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation((input) => {
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

    renderAt('run-1');

    expect(screen.getByText('Loading…')).toBeInTheDocument();

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
});
