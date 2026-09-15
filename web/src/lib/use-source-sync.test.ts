import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Source, WorkflowRun } from '../api/client';
import { clearToasts, getToasts } from '../components/ui/toast';
import { useSourceSync } from './use-source-sync';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL, matching SourcesPage.test.tsx's stubFetch shape.
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

// Drives the fake clock and lets each fetch settle through its response-parsing promise chain, so
// assertions read committed state instead of racing it.
async function tick(ms: number): Promise<void> {
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

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source-1',
    name: 'Deal Room Inbox',
    kind: 'local-folder',
    path: 'deal-room',
    enabled: true,
    fileCount: 3,
    connectivity: 'connector',
    reachability: 'live',
    owner: 'Jane Doe, IT',
    tracked: true,
    sourceClass: 'unclassified',
    createdAt: '2026-08-01T00:00:00.000Z',
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

  it('toasts "Sync requested" whether or not a loop was already running', async () => {
    vi.useFakeTimers();
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(makeRun(), 201),
      '/api/v1/sources/source-2/sync': () =>
        jsonResponse(makeRun({ id: 'run-2', workflowId: 'wf-2' }), 200),
    });

    const { result: freshStart } = renderHook(() => useSourceSync(5));
    await act(async () => {
      await freshStart.current.startSync('source-1', 'Deal Room Inbox');
    });

    const { result: alreadyRunning } = renderHook(() => useSourceSync(5));
    await act(async () => {
      await alreadyRunning.current.startSync('source-2', 'Filing Cabinet');
    });

    expect(getToasts()).toEqual([
      expect.objectContaining({ kind: 'success', message: 'Sync requested for Deal Room Inbox.' }),
      expect.objectContaining({ kind: 'success', message: 'Sync requested for Filing Cabinet.' }),
    ]);
  });

  it('keeps the error inline and leaves the toast store empty on a failed start', async () => {
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
    expect(result.current.sweepState).toBe('idle');
    expect(getToasts()).toEqual([]);
  });

  it('polls the source until lastSyncAt advances past the request, then settles once', async () => {
    vi.useFakeTimers();
    const before = new Date(0).toISOString();
    const onSettled = vi.fn();
    let call = 0;
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(makeRun(), 201),
      '/api/v1/sources/source-1': () => {
        call += 1;
        // The first two reads still carry the sync-before-request timestamp; only the third
        // reflects a sweep that started after `startSync` recorded `requestedAt`.
        const lastSyncAt = call < 3 ? before : new Date(Date.now()).toISOString();
        return jsonResponse(makeSource({ lastSyncAt, lastSyncStatus: 'ok' }));
      },
    });

    const { result } = renderHook(() => useSourceSync(1000, onSettled));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });
    expect(result.current.sweepState).toBe('waiting');

    await tick(1000);
    await tick(1000);
    expect(result.current.sweepState).toBe('waiting');

    await tick(1000);

    expect(result.current.sweepState).toBe('settled');
    expect(result.current.source?.lastSyncAt).not.toBe(before);
    expect(result.current.isPolling).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('reports timed-out without an error when the sweep does not settle within the cap', async () => {
    vi.useFakeTimers();
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(makeRun(), 201),
      '/api/v1/sources/source-1': () => jsonResponse(makeSource()),
    });

    const { result } = renderHook(() => useSourceSync(20_000));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    await tick(20_000);
    await tick(20_000);
    await tick(20_000);
    await tick(20_000);

    expect(result.current.sweepState).toBe('timed-out');
    expect(result.current.syncError).toBeNull();
    expect(result.current.isPolling).toBe(false);
  });

  it('reaches timed-out, not stuck waiting, when every poll fails', async () => {
    vi.useFakeTimers();
    let call = 0;
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(makeRun(), 201),
      '/api/v1/sources/source-1': () => {
        call += 1;
        return jsonResponse({ message: 'Source unavailable' }, 500);
      },
    });

    const { result } = renderHook(() => useSourceSync(20_000));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    await tick(20_000);
    await tick(20_000);
    await tick(20_000);
    await tick(20_000);

    expect(result.current.sweepState).toBe('timed-out');
    expect(result.current.isPolling).toBe(false);
    expect(result.current.syncError).toBe('Source unavailable');

    const callsAtDeadline = call;
    await tick(20_000);
    await tick(20_000);
    expect(call).toBe(callsAtDeadline);
  });

  it('a 404 poll response ends the sweep at once, without waiting for the deadline', async () => {
    vi.useFakeTimers();
    let call = 0;
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(makeRun(), 201),
      '/api/v1/sources/source-1': () => {
        call += 1;
        return jsonResponse({ message: "Source 'source-1' not found" }, 404);
      },
    });

    const { result } = renderHook(() => useSourceSync(1000));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    await tick(1000);

    expect(result.current.sweepState).toBe('gone');
    expect(result.current.syncError).toBe("Source 'source-1' not found");
    expect(call).toBe(1);

    await tick(1000);
    await tick(1000);
    expect(call).toBe(1);
  });

  it('never starts a second poll while one is still in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | undefined;
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(makeRun(), 201),
      '/api/v1/sources/source-1': () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Response>((resolve) => {
          release = () => {
            inFlight -= 1;
            resolve(jsonResponse(makeSource()));
          };
        });
      },
    });

    const { result } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    // Real timers: lets several 5ms ticks elapse while the first poll's response is still
    // pending, so an in-flight guard is the only thing that could keep a second one from firing.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(maxInFlight).toBe(1);
    release?.();
  });

  it('drops a poll response that lands after unmount instead of setting state on the unmounted hook', async () => {
    let release!: () => void;
    const deferred = new Promise<Response>((resolve) => {
      release = () => resolve(jsonResponse(makeSource()));
    });
    stubFetch({
      '/api/v1/sources/source-1/sync': () => jsonResponse(makeRun(), 201),
      '/api/v1/sources/source-1': () => deferred,
    });

    const { result, unmount } = renderHook(() => useSourceSync(5));

    await act(async () => {
      await result.current.startSync('source-1', 'Deal Room Inbox');
    });

    // Real timers here: lets the 5ms interval fire and issue its (still-unresolved) fetch
    // before the hook unmounts out from under it.
    await new Promise((resolve) => setTimeout(resolve, 20));

    unmount();
    release();
    await deferred;
  });
});
