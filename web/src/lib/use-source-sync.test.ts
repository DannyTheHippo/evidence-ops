import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from '../api/client';
import { clearToasts, getToasts } from '../components/ui/toast';
import { useSourceSync } from './use-source-sync';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL and method, matching SourcesPage.test.tsx's stubFetch shape.
type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

function stubFetch(routes: Record<string, RouteHandler>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// A fetch response the test releases by hand, so an in-flight poll can be made to land after a
// later one — the ordering a wall-clock delay can only approximate.
function deferredResponse(body: unknown): { response: Promise<Response>; release: () => void } {
  let release!: () => void;
  const response = new Promise<Response>((resolve) => {
    release = () => resolve(jsonResponse(body));
  });
  return { response, release };
}

// Drives the fake clock and lets each fetch settle through its response-parsing promise chain, so
// assertions read committed state instead of racing it.
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    status: 'running',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('useSourceSync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearToasts();
  });

  it('starts a sync, holds the returned run, and toasts success', async () => {
    const run = makeRun({ status: 'completed' });
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
    });

    const { result } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    expect(result.current.run).toEqual(run);
    expect(result.current.isPolling).toBe(false);
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'success', message: 'Sync started for Deal Room Inbox.' }),
    );
  });

  it('reports a failed start without leaving starting stuck true, and toasts the error', async () => {
    stubFetch({
      '/api/v1/sources/source-1/sync': () =>
        jsonResponse({ message: 'Sync already in progress' }, 409),
    });

    const { result } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    expect(result.current.syncError).toBe('Sync already in progress');
    expect(result.current.starting).toBe(false);
    expect(getToasts()).toContainEqual(
      expect.objectContaining({ kind: 'error', message: 'Sync already in progress' }),
    );
  });

  it('stops polling the sync run once it reaches a terminal state', async () => {
    const runningRun = makeRun({ status: 'running' });
    const completedRun = makeRun({ status: 'completed' });

    const fetchMock = stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () => jsonResponse(completedRun),
    });

    const { result } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    await waitFor(() => {
      expect(result.current.isPolling).toBe(false);
    });
    expect(result.current.run).toEqual(completedRun);

    // Assert the poll count stops growing rather than that a poisoned response fails to apply:
    // with a short interval several polls are in flight before the effect tears down, so a
    // state-based assertion alone races that teardown.
    const pollCalls = () =>
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/workflow-runs/run-1').length;
    const callsAtCompletion = pollCalls();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(pollCalls()).toBe(callsAtCompletion);
  });

  it('keeps a single polling interval across sync-run ticks that repeat the same status', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const runningRun = makeRun({ status: 'running' });
    // Each poll deserialises into a fresh object, so an effect keyed on the run object rather than
    // its id and status would tear the interval down and rebuild it on every tick.
    const fetchMock = stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () => jsonResponse(runningRun),
    });

    const { result } = renderHook(() => useSourceSync(1000));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });
    await tick();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await tick(1000);
    await tick(1000);
    await tick(1000);

    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/workflow-runs/run-1').length,
    ).toBe(3);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('drops a sync-run poll response that lands after a later one already completed the run', async () => {
    const runningRun = makeRun({ status: 'running' });
    const completedRun = makeRun({ status: 'completed' });
    // The first poll's own response, held back until after a later poll reported completion.
    // Applying it would walk the run backwards from a finished sync to a running one.
    const stale = deferredResponse(runningRun);

    let pollCall = 0;
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () => {
        pollCall += 1;
        return pollCall === 1 ? stale.response : jsonResponse(completedRun);
      },
    });

    const { result } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    await waitFor(() => {
      expect(result.current.run).toEqual(completedRun);
    });

    // act's async exit crosses a macrotask boundary, which drains the released response's whole
    // promise chain — no timer, so no wall-clock race.
    await act(async () => {
      stale.release();
      await stale.response;
    });

    expect(result.current.run).toEqual(completedRun);
    expect(result.current.isPolling).toBe(false);
  });

  it('drops a late poll response after unmount instead of setting state on the unmounted hook', async () => {
    const runningRun = makeRun({ status: 'running' });
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () => jsonResponse(runningRun),
    });

    const { result, unmount } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    // No assertion on result.current after unmount — this only proves the poll's cleanup does
    // not throw or warn ("state update on an unmounted component") once a scheduled tick lands.
    act(() => unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('reports a poll failure without clearing the in-flight run', async () => {
    const runningRun = makeRun({ status: 'running' });
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () =>
        jsonResponse({ message: 'Failed to poll sync run' }, 500),
    });

    const { result } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    await waitFor(() => {
      expect(result.current.syncError).toBe('Failed to poll sync run');
    });
    expect(result.current.run).toEqual(runningRun);
  });
});
