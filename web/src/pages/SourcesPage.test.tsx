import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import type { Source, WorkflowRun } from '../api/client';
import SourcesPage from './SourcesPage';

const TRACKED_URL = '/api/v1/sources?skip=0&limit=20&tracked=true';
const INVENTORY_URL = '/api/v1/sources?skip=0&limit=20&tracked=false';
const ME_URL = '/api/v1/auth/me';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL and method, matching ApprovalsPage.test.tsx's stubFetch shape. Stubbing fetch
// keeps client.ts in the path under test — URL construction, credentials, status handling and
// error-message extraction all stay exercised. Every route not given here 404s the empty pager
// stub for the two list URLs, so a test only has to override what it cares about.
type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

function stubFetch(
  routes: Record<string, RouteHandler> = {},
  session: RouteHandler = () => jsonResponse(admin),
) {
  const defaults: Record<string, RouteHandler> = {
    [ME_URL]: session,
    [TRACKED_URL]: () => jsonResponse({ docs: [], count: 0 }),
    [INVENTORY_URL]: () => jsonResponse({ docs: [], count: 0 }),
    ...routes,
  };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = defaults[url];
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
    connectivity: 'connector',
    reachability: 'live',
    owner: 'Jane Doe, IT',
    tracked: true,
    sourceClass: 'unclassified',
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
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
  });

  it('shows a status region for each list while both are loading', () => {
    stubFetch({
      [TRACKED_URL]: () => new Promise<Response>(() => {}),
      [INVENTORY_URL]: () => new Promise<Response>(() => {}),
    });

    renderPage();

    expect(screen.getByText('Loading sources…')).toBeInTheDocument();
    expect(screen.getByText('Loading inventory…')).toBeInTheDocument();
  });

  it('reads as "nothing here yet" on an empty source list, for both lists independently', async () => {
    stubFetch();

    renderPage();

    expect(
      await screen.findByText('No sources yet — add one to start syncing documents.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No inventory-only repositories yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error when the synced list fails to load, without blocking the inventory list', async () => {
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ message: 'Failed to load sources' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load sources');
    expect(await screen.findByText('No inventory-only repositories yet.')).toBeInTheDocument();
  });

  it('lists a populated source with its status, interval, owner, reach, class, last sync, and file count', async () => {
    const source = makeSource({
      enabled: false,
      intervalMs: 300_000,
      lastSyncAt: '2026-08-01T12:00:00.000Z',
      lastSyncStatus: 'failed',
      lastSyncError: 'ENOENT: no such directory',
      fileCount: 7,
      owner: 'Jane Doe, IT',
      connectivity: 'export-only',
      reachability: 'possible',
      sourceClass: 'crm-export',
    });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Sources syncing documents into this data room' }),
    ).toBeInTheDocument();
    expect(screen.getByText('deal-room')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe, IT')).toBeInTheDocument();
    expect(screen.getByText('Every 5 minutes')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
    expect(
      screen.getByText(new Date(source.lastSyncAt as string).toLocaleString()),
    ).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('ENOENT: no such directory')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('possible')).toBeInTheDocument();
    expect(screen.getByText('export-only')).toBeInTheDocument();
    expect(screen.getByText('crm-export')).toBeInTheDocument();
  });

  it('renders Unassigned as muted text, not a badge, when a source has no owner', async () => {
    const source = makeSource({ owner: undefined });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    const unassigned = await screen.findByText('Unassigned');
    expect(unassigned.className).toContain('cell-sub');
  });

  it.each([
    ['live', 'verified', 'badge--strong'],
    ['possible', 'caution', 'badge--possible'],
    ['prohibited', 'neutral', 'badge--neutral'],
  ] as const)(
    'maps reachability %s to the %s tone, never the rejected octagon',
    async (reachability, _tone, badgeClass) => {
      const source = makeSource({ reachability });
      stubFetch({
        [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      });

      renderPage();

      const badge = await screen.findByText(reachability);
      expect(badge.className).toContain(badgeClass);
      expect(badge.className).not.toContain('badge--reject');
    },
  );

  it('shows a default-interval label for a source with no configured interval', async () => {
    const source = makeSource({ intervalMs: undefined });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Default interval')).toBeInTheDocument();
  });

  it('flags an enabled source with a carried sync error as failed, not disabled', async () => {
    const source = makeSource({ enabled: true, lastSyncError: 'ENOENT: no such directory' });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(screen.queryByText('disabled')).not.toBeInTheDocument();
  });

  it('links each synced source row to its detail page via a reachable row link', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    const link = await screen.findByRole('link', { name: 'Deal Room Inbox' });
    expect(link).toHaveAttribute('href', '/sources/source-1');
  });

  it('shows the synced list total alongside Previous/Next, disabled at the ends', async () => {
    const first = makeSource({ id: 'source-1', name: 'Deal Room Inbox' });
    const second = makeSource({ id: 'source-2', name: 'Diligence Drive' });
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [first], count: 25 }),
      '/api/v1/sources?skip=20&limit=20&tracked=true': () =>
        jsonResponse({ docs: [second], count: 25 }),
    });

    renderPage();

    // Both lists render their own Pager, so both carry a "Previous"/"Next" pair — the tracked
    // list's pager is the first of each in DOM order, since its section renders before Inventory.
    expect(await screen.findByText('25 total')).toBeInTheDocument();
    const [trackedPrev] = screen.getAllByRole('button', { name: 'Previous' });
    const [trackedNext] = screen.getAllByRole('button', { name: 'Next' });
    expect(trackedPrev).toBeDisabled();
    expect(trackedNext).not.toBeDisabled();

    fireEvent.click(trackedNext);

    expect(await screen.findByText('Diligence Drive')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/sources?skip=20&limit=20&tracked=true'),
    ).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Previous' })[0]).not.toBeDisabled();
  });

  it('shows inventory-only sources in their own table with Owner/Reach/Class columns only', async () => {
    const inventorySource = makeSource({
      id: 'source-3',
      name: 'Export Drop',
      tracked: false,
      reachability: 'prohibited',
      connectivity: 'manual',
      sourceClass: 'memo',
      owner: 'Ops Team',
    });
    stubFetch({
      [INVENTORY_URL]: () => jsonResponse({ docs: [inventorySource], count: 1 }),
    });

    renderPage();

    expect(
      await screen.findByRole('table', {
        name: 'Repositories catalogued for the estate but never synced',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Export Drop')).toBeInTheDocument();
    expect(screen.getByText('Ops Team')).toBeInTheDocument();
    expect(screen.getByText('prohibited')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
    expect(screen.getByText('memo')).toBeInTheDocument();
    // Inventory rows carry no sync-status, interval or file-count vocabulary.
    expect(screen.queryByText('Interval')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('shows the inventory list total alongside its own Previous/Next, independent of the synced pager', async () => {
    const first = makeSource({ id: 'source-3', name: 'Export Drop', tracked: false });
    const second = makeSource({ id: 'source-4', name: 'Legacy Share', tracked: false });
    stubFetch({
      [INVENTORY_URL]: () => jsonResponse({ docs: [first], count: 25 }),
      '/api/v1/sources?skip=20&limit=20&tracked=false': () =>
        jsonResponse({ docs: [second], count: 25 }),
    });

    renderPage();

    await screen.findByText('Export Drop');
    const pagers = screen.getAllByText('25 total');
    expect(pagers).toHaveLength(1);

    // The inventory list's pager is the second "Next" in DOM order — the tracked (empty, default)
    // list's pager is first and stays disabled throughout this test.
    const nextButtons = screen.getAllByRole('button', { name: 'Next' });
    fireEvent.click(nextButtons[1]);

    expect(await screen.findByText('Legacy Share')).toBeInTheDocument();
  });

  it('an admin creates a synced source, which reloads and appears in the synced list', async () => {
    const created = makeSource({
      id: 'source-2',
      name: 'New Source',
      path: 'new-folder',
      owner: 'Jane Doe, IT',
      tracked: true,
    });
    let trackedCall = 0;
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => {
        trackedCall += 1;
        return trackedCall === 1
          ? jsonResponse({ docs: [], count: 0 })
          : jsonResponse({ docs: [created], count: 1 });
      },
      '/api/v1/sources': (init) => {
        if (init?.method === 'POST') return jsonResponse(created, 201);
        return Promise.reject(new Error('unexpected'));
      },
    });

    renderPage();

    await screen.findByText('No sources yet — add one to start syncing documents.');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Source' } });
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'Jane Doe, IT' } });
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
      owner: 'Jane Doe, IT',
      tracked: true,
    });
    expect(screen.queryByLabelText('Name')).toHaveValue('');
    expect(trackedCall).toBe(2);
  });

  it('an admin creates an inventory-only source, which reloads the inventory list, not the synced one', async () => {
    const created = makeSource({
      id: 'source-3',
      name: 'Export Drop',
      path: 'export-drop',
      owner: 'Ops Team',
      tracked: false,
    });
    let inventoryCall = 0;
    stubFetch({
      [INVENTORY_URL]: () => {
        inventoryCall += 1;
        return inventoryCall === 1
          ? jsonResponse({ docs: [], count: 0 })
          : jsonResponse({ docs: [created], count: 1 });
      },
      '/api/v1/sources': (init) => {
        if (init?.method === 'POST') return jsonResponse(created, 201);
        return Promise.reject(new Error('unexpected'));
      },
    });

    renderPage();

    await screen.findByText('No inventory-only repositories yet.');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Export Drop' } });
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'Ops Team' } });
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: 'export-drop' } });
    fireEvent.change(screen.getByLabelText('Tracked'), { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('Export Drop')).toBeInTheDocument();
    expect(inventoryCall).toBe(2);
  });

  it('toggles a source from enabled to disabled', async () => {
    const source = makeSource({ enabled: true });
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1': (init) =>
        init?.method === 'PATCH'
          ? jsonResponse({ ...source, enabled: false })
          : jsonResponse({ message: 'unexpected' }, 500),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
    const toggleCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/sources/source-1' && init?.method === 'PATCH',
    );
    expect(toggleCall).toBeDefined();
    expect(JSON.parse((toggleCall?.[1] as RequestInit).body as string)).toEqual({
      enabled: false,
    });
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('shows an error when toggling a source fails', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1': () => jsonResponse({ message: 'Failed to update source' }, 500),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to update source');
    });
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('starts a sync and links to the resulting workflow run', async () => {
    const source = makeSource();
    const run = makeRun({ status: 'completed' });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
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

    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () => jsonResponse(completedRun),
    });

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
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
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
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(runningRun, 201),
      '/api/v1/workflow-runs/run-1': () => {
        pollCall += 1;
        return pollCall === 1 ? stale.response : jsonResponse(completedRun);
      },
    });

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
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () =>
        jsonResponse({ message: 'Sync already in progress' }, 409),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sync already in progress');
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeDisabled();
  });

  it('a member sees why they cannot add or manage sources, and cannot reach the create form', async () => {
    stubFetch({}, () => jsonResponse(member));

    renderPage();

    expect(
      await screen.findByText('Adding and configuring sources requires an admin.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('a member does not see the enable/disable toggle, but still sees Sync now', async () => {
    const source = makeSource();
    stubFetch(
      {
        [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      },
      () => jsonResponse(member),
    );

    renderPage();

    await screen.findByText('Deal Room Inbox');
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it('withholds the admin-only notice until the session probe resolves, then admits the admin', async () => {
    let resolveMe: (res: Response) => void;
    const pendingMe = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });
    stubFetch({}, () => pendingMe);

    renderPage();

    await screen.findByText('No sources yet — add one to start syncing documents.');
    expect(
      screen.queryByText('Adding and configuring sources requires an admin.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();

    act(() => {
      resolveMe!(jsonResponse(admin));
    });

    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    expect(
      screen.queryByText('Adding and configuring sources requires an admin.'),
    ).not.toBeInTheDocument();
  });
});
