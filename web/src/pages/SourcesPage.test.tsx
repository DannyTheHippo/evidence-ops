import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Source, WorkflowRun } from '../api/client';
import SourcesPage from './SourcesPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL and method, matching ApprovalsPage.test.tsx's stubFetch shape. Stubbing fetch
// keeps client.ts in the path under test — URL construction, credentials, status handling and
// error-message extraction all stay exercised.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>) {
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

// Drives the fake clock and lets each fetch settle through its response-parsing promise chain,
// so assertions read committed state instead of racing it. Testing Library cannot detect a fake
// clock without vitest globals, so `waitFor`/`findBy*` hang here — advance the clock instead.
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source-1',
    name: 'Deal Room Inbox',
    kind: 'local-folder',
    path: 'deal-room',
    enabled: true,
    fileCount: 3,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
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

function renderPage(pollIntervalMs = 5) {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<SourcesPage pollIntervalMs={pollIntervalMs} />} />
        {/* Static, not :id — pins the sync link assertion to the run's own id, not anything
            else on the source, so a regression to the wrong field fails the test. */}
        <Route path="/workflow-runs/run-1" element={<p>run page probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SourcesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads as "nothing here yet" on an empty source list', async () => {
    stubFetch({
      '/api/v1/sources': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(
      await screen.findByText('No sources yet — add one to start syncing documents.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error when the source list fails to load', async () => {
    stubFetch({
      '/api/v1/sources': () => jsonResponse({ message: 'Failed to load sources' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load sources');
  });

  it('lists a populated source with its status, last sync, and file count', async () => {
    const source = makeSource({
      enabled: false,
      lastSyncAt: '2026-08-01T12:00:00.000Z',
      lastSyncStatus: 'failed',
      lastSyncError: 'ENOENT: no such directory',
      fileCount: 7,
    });
    stubFetch({
      '/api/v1/sources': () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(screen.getByText('deal-room')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
    expect(
      screen.getByText(new Date(source.lastSyncAt as string).toLocaleString()),
    ).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('ENOENT: no such directory')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('creates a source and adds it to the list', async () => {
    const created = makeSource({ id: 'source-2', name: 'New Source', path: 'new-folder' });
    // The list GET and the create POST share a URL, so this one branches on method.
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/sources' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(created, 201));
      }
      if (url === '/api/v1/sources') return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByText('No sources yet — add one to start syncing documents.');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Source' } });
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'new-folder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('New Source')).toBeInTheDocument();

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/sources' && init?.method === 'POST',
    );
    expect(createCall).toBeDefined();
    // A blank interval field sends no `intervalMs` at all, rather than 0 or NaN.
    expect(JSON.parse((createCall?.[1] as RequestInit).body as string)).toEqual({
      name: 'New Source',
      kind: 'local-folder',
      path: 'new-folder',
    });
    expect(screen.queryByLabelText('Name')).toHaveValue('');
  });

  it('toggles a source from enabled to disabled', async () => {
    const source = makeSource({ enabled: true });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/sources') {
        return Promise.resolve(jsonResponse({ docs: [source], count: 1 }));
      }
      if (url === '/api/v1/sources/source-1' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...source, enabled: false }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
    const toggleCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/sources/source-1' && init?.method === 'PATCH',
    );
    expect(toggleCall).toBeDefined();
    expect(JSON.parse((toggleCall?.[1] as RequestInit).body as string)).toEqual({ enabled: false });
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('starts a sync and links to the resulting workflow run', async () => {
    const source = makeSource();
    const run = makeRun({ status: 'completed' });
    stubFetch({
      '/api/v1/sources': () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    const link = await screen.findByRole('link', { name: 'Sync completed' });
    expect(link).toHaveAttribute('href', '/workflow-runs/run-1');

    fireEvent.click(link);
    expect(await screen.findByText('run page probe')).toBeInTheDocument();
  });

  it('stops polling the sync run once it reaches a terminal state', async () => {
    const source = makeSource();
    const runningRun = makeRun({ status: 'running' });
    const completedRun = makeRun({ status: 'completed' });

    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/sources') {
        return Promise.resolve(jsonResponse({ docs: [source], count: 1 }));
      }
      if (url === '/api/v1/sources/source-1/sync') {
        return Promise.resolve(jsonResponse(runningRun, 201));
      }
      if (url === '/api/v1/workflow-runs/run-1') return Promise.resolve(jsonResponse(completedRun));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    await screen.findByRole('link', { name: 'Sync completed' });

    // Assert the poll count stops growing rather than that a poisoned response fails to render:
    // with a short interval several polls are in flight before React re-renders, so a
    // render-based assertion races the teardown and fails intermittently. Call count is the
    // property actually under test — "the interval was cleared" — and it is deterministic.
    const pollCalls = () =>
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/workflow-runs/run-1').length;
    const callsAtCompletion = pollCalls();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(pollCalls()).toBe(callsAtCompletion);
    expect(screen.getByRole('link', { name: 'Sync completed' })).toBeInTheDocument();
  });

  it('keeps a single polling interval across sync-run ticks that repeat the same status', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const source = makeSource();
    const runningRun = makeRun({ status: 'running' });
    // Each poll deserialises into a fresh object, so an effect keyed on the run object rather than
    // its id and status would tear the interval down and rebuild it on every tick.
    const fetchMock = stubFetch({
      '/api/v1/sources': () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () => jsonResponse(runningRun),
    });

    renderPage(1000);
    await tick();

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
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
    const source = makeSource();
    const runningRun = makeRun({ status: 'running' });
    const completedRun = makeRun({ status: 'completed' });
    // The first poll's own response, held back until after a later poll reported completion.
    // Applying it would walk the row backwards from a finished sync to a running one.
    const stale = deferredResponse(runningRun);

    let pollCall = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/sources') {
        return Promise.resolve(jsonResponse({ docs: [source], count: 1 }));
      }
      if (url === '/api/v1/sources/source-1/sync') {
        return Promise.resolve(jsonResponse(runningRun, 201));
      }
      if (url === '/api/v1/workflow-runs/run-1') {
        pollCall += 1;
        return pollCall === 1 ? stale.response : Promise.resolve(jsonResponse(completedRun));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    await screen.findByRole('link', { name: 'Sync completed' });

    // act's async exit crosses a macrotask boundary, which drains the released response's whole
    // promise chain — no timer, so no wall-clock race.
    await act(async () => {
      stale.release();
      await stale.response;
    });

    expect(screen.getByRole('link', { name: 'Sync completed' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sync running…' })).not.toBeInTheDocument();
  });

  it('shows an error when the sync request fails, without blocking further attempts', async () => {
    const source = makeSource();
    stubFetch({
      '/api/v1/sources': () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () =>
        jsonResponse({ message: 'Sync already in progress' }, 409),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sync already in progress');
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeDisabled();
  });

  it('shows an error when toggling a source fails', async () => {
    const source = makeSource();
    stubFetch({
      '/api/v1/sources': () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1': () => jsonResponse({ message: 'Failed to update source' }, 500),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to update source');
    });
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });
});
