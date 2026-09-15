import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAnnouncements, subscribeAnnouncements } from '../lib/announce';
import { clearSession } from '../lib/auth';
import { formatRelativeTimestamp } from '../lib/format-timestamp';
import type { Source, WorkflowRun } from '../api/client';
import SourcesPage from './SourcesPage';

const TRACKED_URL = '/api/v1/sources?skip=0&limit=25&tracked=true&sort=name&sortDir=asc';
const INVENTORY_URL = '/api/v1/sources?skip=0&limit=25&tracked=false&sort=name&sortDir=asc';
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

// Dispatches by URL and method. Both list URLs default to an empty page so a test only has to
// override what it cares about — both fetches fire on every render regardless of which view is on
// screen, so both need a default.
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

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    status: 'running',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Exposes the current query string as accessible text, matching AnswersPage.test.tsx's probe —
// proves the URL round-trip without reaching into router internals.
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current search">{location.search}</output>;
}

function renderPage(initialEntries: string[] = ['/sources'], pollIntervalMs = 5) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="/sources"
          element={
            <>
              <SourcesPage pollIntervalMs={pollIntervalMs} />
              <LocationProbe />
            </>
          }
        />
        {/* Static, not :id — pins the sync link assertion to the run's own id, not anything
            else on the source, so a regression to the wrong field fails the test. */}
        <Route path="/workflow-runs/run-1" element={<p>run page probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

// Drives the fake clock and lets each fetch settle through its response-parsing promise chain, so
// assertions read committed state instead of racing it — mirrors WorkflowRunPage.test.tsx's helper
// of the same name.
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

// Opens the create dialog and fills the three required fields, leaving `tracked` at its default
// ('Synced by a connector') and the interval field untouched — every create test starts from here.
function openCreateDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'New source' }));
  return screen.getByRole('dialog', { name: 'New source' });
}

function fillRequiredFields(name: string, owner: string, path: string) {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Owner'), { target: { value: owner } });
  fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: path } });
}

describe('SourcesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
    clearAnnouncements();
  });

  it('shows a status region for the active (tracked) list while it loads', () => {
    stubFetch({
      [TRACKED_URL]: () => new Promise<Response>(() => {}),
    });

    renderPage();

    expect(screen.getByText('Loading sources…')).toBeInTheDocument();
  });

  it('reads as "nothing here yet" on an empty tracked list, the default view', async () => {
    stubFetch();

    renderPage();

    expect(await screen.findByText('No sources yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('switches to the repository inventory view, updating aria-pressed and showing its own empty state', async () => {
    stubFetch();

    renderPage();
    await screen.findByText('No sources yet');

    const trackedButton = screen.getByRole('button', { name: 'Tracked sources' });
    const inventoryButton = screen.getByRole('button', { name: 'Repository inventory' });
    expect(trackedButton).toHaveAttribute('aria-pressed', 'true');
    expect(inventoryButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(inventoryButton);

    expect(await screen.findByText('No inventory-only repositories yet')).toBeInTheDocument();
    expect(screen.queryByText('No sources yet')).not.toBeInTheDocument();
    expect(trackedButton).toHaveAttribute('aria-pressed', 'false');
    expect(inventoryButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the segment counts as aria-hidden, so the accessible name stays just the label', async () => {
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    const trackedButton = screen.getByRole('button', { name: 'Tracked sources' });
    expect(trackedButton).toHaveTextContent('(1)');
  });

  it('shows an error when the active (tracked) list fails to load', async () => {
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ message: 'Failed to load sources' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load sources');
  });

  it('lists a populated source with its status, reach, cadence, created date and file count', async () => {
    const source = makeSource({
      enabled: true,
      intervalMs: 300_000,
      lastSyncAt: '2026-08-01T12:00:00.000Z',
      lastSyncStatus: 'failed',
      lastSyncError: 'ENOENT: no such directory',
      fileCount: 7,
      owner: 'Jane Doe, IT',
      connectivity: 'export-only',
      reachability: 'possible',
      sourceClass: 'crm-export',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Sources syncing documents into this data room' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Sources syncing documents into this data room' }),
    ).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('deal-room')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe, IT')).toBeInTheDocument();
    expect(screen.getByText('Every 5 minutes')).toBeInTheDocument();
    // Status reads 'Sync failed' from lastSyncStatus, one vocabulary shared with the detail page.
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
    // The truncated status detail is a keyboard stop whose focus opens the full-text tooltip.
    const detail = screen.getByText('ENOENT: no such directory');
    expect(detail).toHaveAttribute('tabindex', '0');
    detail.focus();
    const detailTooltip = await screen.findByRole('tooltip');
    expect(detailTooltip).toHaveTextContent('ENOENT: no such directory');
    expect(detail).toHaveAttribute('aria-describedby', detailTooltip.id);
    expect(
      screen.getByText(formatRelativeTimestamp(source.lastSyncAt as string)),
    ).toBeInTheDocument();
    expect(screen.getByText(formatRelativeTimestamp(source.createdAt))).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('possible')).toBeInTheDocument();
    // Reach's sub-line folds connectivity and class together — the tracked table has no separate
    // Class column.
    expect(screen.getByText('export-only · crm-export')).toBeInTheDocument();

    // The colgroup is what lets Name's `.cell-truncate` path actually clip under a fixed table
    // layout: every other column states a width, and Name (the leading col) carries none.
    // Owner/Last sync/Created/Files are trimmed below `col-narrow`: Owner truncates with a tooltip,
    // Last sync and Created truncate their timestamps with none, and Files is a bare number. That
    // keeps the `.sources-grid` floor at 72rem, so Name keeps its room without the table overflowing
    // its panel at a 1440px viewport even with a 17px classic scrollbar on the page container.
    const cols = screen.getByRole('table').querySelectorAll('col');
    expect(cols).toHaveLength(8);
    expect(cols[0]).not.toHaveAttribute('class');
    expect(cols[1]).toHaveClass('col-thin');
    // Status holds a short badge plus its truncating detail line; Actions holds the two small
    // buttons, which need the wider column to share one line.
    expect(cols[2]).toHaveClass('col-wide');
    expect(cols[3]).toHaveClass('col-compact');
    expect(cols[4]).toHaveClass('col-snug');
    expect(cols[5]).toHaveClass('col-slim');
    expect(cols[6]).toHaveClass('col-tiny');
    expect(cols[7]).toHaveClass('col-badge');
    expect(screen.getByRole('table')).toHaveClass('sources-grid');
  });

  it('makes the name, path, owner and connectivity tooltips keyboard-reachable', async () => {
    const source = makeSource({
      owner: 'Jane Doe, IT',
      connectivity: 'export-only',
      sourceClass: 'crm-export',
    });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    // Each site closes (100ms) before the next opens (300ms) — waiting out the close keeps
    // `findByRole('tooltip')` from matching a still-open previous site's surface.
    async function assertReachable(element: HTMLElement, expectedText: string) {
      element.focus();
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent(expectedText);
      expect(element).toHaveAttribute('aria-describedby', tooltip.id);
      element.blur();
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    }

    // Name: the Tooltip wraps the RowLink, so keyboard focus on the link opens it and the link
    // itself carries the description — no explicit tabIndex, the link is natively focusable.
    await assertReachable(screen.getByRole('link', { name: 'Deal Room Inbox' }), 'Deal Room Inbox');

    const path = screen.getByText('deal-room');
    expect(path).toHaveAttribute('tabindex', '0');
    await assertReachable(path, 'deal-room');

    const owner = screen.getByText('Jane Doe, IT');
    expect(owner).toHaveAttribute('tabindex', '0');
    await assertReachable(owner, 'Jane Doe, IT');

    const connectivity = screen.getByText('export-only · crm-export');
    expect(connectivity).toHaveAttribute('tabindex', '0');
    await assertReachable(connectivity, 'export-only · crm-export');
  });

  it('makes the inventory name and path tooltips keyboard-reachable', async () => {
    const source = makeSource({ tracked: false });
    stubFetch({
      [INVENTORY_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();
    await screen.findByText('No sources yet');
    fireEvent.click(screen.getByRole('button', { name: 'Repository inventory' }));
    await screen.findByText('Deal Room Inbox');

    async function assertReachable(element: HTMLElement, expectedText: string) {
      element.focus();
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent(expectedText);
      expect(element).toHaveAttribute('aria-describedby', tooltip.id);
      element.blur();
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    }

    await assertReachable(screen.getByRole('link', { name: 'Deal Room Inbox' }), 'Deal Room Inbox');

    const path = screen.getByText('deal-room');
    expect(path).toHaveAttribute('tabindex', '0');
    await assertReachable(path, 'deal-room');
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
    const source = makeSource({
      enabled: true,
      lastSyncStatus: 'failed',
      lastSyncError: 'ENOENT: no such directory',
    });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Sync failed')).toBeInTheDocument();
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
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

  it('shows the tracked list total alongside Previous/Next, disabled at the ends', async () => {
    const first = makeSource({ id: 'source-1', name: 'Deal Room Inbox' });
    const second = makeSource({ id: 'source-2', name: 'Diligence Drive' });
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [first], count: 30 }),
      '/api/v1/sources?skip=25&limit=25&tracked=true&sort=name&sortDir=asc': () =>
        jsonResponse({ docs: [second], count: 30 }),
    });

    renderPage();

    expect(await screen.findByText('1–25 of 30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(next);

    expect(await screen.findByText('Diligence Drive')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/sources?skip=25&limit=25&tracked=true&sort=name&sortDir=asc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('shows inventory-only sources with Owner/Reach/Class/Created columns only, no sync state', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Repository inventory' }));

    expect(
      await screen.findByRole('table', {
        name: 'Repositories catalogued for the estate but never synced',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', {
        name: 'Repositories catalogued for the estate but never synced',
      }),
    ).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Export Drop')).toBeInTheDocument();
    expect(screen.getByText('Ops Team')).toBeInTheDocument();
    expect(screen.getByText('prohibited')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
    expect(screen.getByText('memo')).toBeInTheDocument();
    // Inventory rows carry no sync-status or file-count vocabulary.
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();

    const cols = screen.getByRole('table').querySelectorAll('col');
    expect(cols).toHaveLength(5);
    expect(cols[0]).not.toHaveAttribute('class');
    expect(cols[2]).toHaveClass('col-compact');
    expect(screen.getByRole('table')).toHaveClass('sources-grid--inventory');
  });

  it('shows the inventory list total alongside its own Previous/Next, independent of the tracked pager', async () => {
    const first = makeSource({ id: 'source-3', name: 'Export Drop', tracked: false });
    const second = makeSource({ id: 'source-4', name: 'Legacy Share', tracked: false });
    stubFetch({
      [INVENTORY_URL]: () => jsonResponse({ docs: [first], count: 30 }),
      '/api/v1/sources?skip=25&limit=25&tracked=false&sort=name&sortDir=asc': () =>
        jsonResponse({ docs: [second], count: 30 }),
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Repository inventory' }));
    await screen.findByText('Export Drop');

    const next = screen.getByRole('button', { name: 'Next' });
    fireEvent.click(next);

    expect(await screen.findByText('Legacy Share')).toBeInTheDocument();
  });

  it('an admin creates a tracked source through the New source dialog, which reloads the (already active) tracked view', async () => {
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
    await screen.findByText('No sources yet');

    openCreateDialog();
    fillRequiredFields('New Source', 'Jane Doe, IT', 'new-folder');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('New Source')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

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
      connectivity: 'connector',
      reachability: 'live',
      sourceClass: 'unclassified',
    });
    expect(trackedCall).toBe(2);
  });

  it('an admin creates an inventory-only source by choosing Catalogued only, which switches to and reloads the inventory view', async () => {
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
    await screen.findByText('No sources yet');

    openCreateDialog();
    fillRequiredFields('Export Drop', 'Ops Team', 'export-drop');
    fireEvent.click(screen.getByRole('radio', { name: 'Catalogued only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    // The page switched itself to the inventory view — the created source is visible without a
    // manual click on "Repository inventory".
    expect(await screen.findByText('Export Drop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repository inventory' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(inventoryCall).toBe(2);
  });

  it('creates a catalogued-only source with manual connectivity and possible reachability', async () => {
    const created = makeSource({
      id: 'source-3',
      name: 'Export Drop',
      path: 'export-drop',
      owner: 'Ops Team',
      tracked: false,
      connectivity: 'manual',
      reachability: 'possible',
    });
    const fetchMock = stubFetch({
      [INVENTORY_URL]: () => jsonResponse({ docs: [created], count: 1 }),
      '/api/v1/sources': (init) => {
        if (init?.method === 'POST') return jsonResponse(created, 201);
        return Promise.reject(new Error('unexpected'));
      },
    });

    renderPage();
    await screen.findByText('No sources yet');

    openCreateDialog();
    fillRequiredFields('Export Drop', 'Ops Team', 'export-drop');
    // Choosing Catalogued only moves Connectivity/Reachability away from the connector/live
    // posture meant for a synced source, without the admin having to touch either radio.
    fireEvent.click(screen.getByRole('radio', { name: 'Catalogued only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    await screen.findByText('Export Drop');
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/sources' && init?.method === 'POST',
    );
    expect(JSON.parse((createCall?.[1] as RequestInit).body as string)).toEqual({
      name: 'Export Drop',
      kind: 'local-folder',
      path: 'export-drop',
      owner: 'Ops Team',
      tracked: false,
      connectivity: 'manual',
      reachability: 'possible',
      sourceClass: 'unclassified',
    });
  });

  it('clears an applied search after a create so the new source is visible', async () => {
    const created = makeSource({ id: 'source-2', name: 'New Source', tracked: true });
    stubFetch({
      [`${TRACKED_URL}&q=diligence`]: () => jsonResponse({ docs: [], count: 0 }),
      [TRACKED_URL]: () => jsonResponse({ docs: [created], count: 1 }),
      '/api/v1/sources': (init) =>
        init?.method === 'POST'
          ? jsonResponse(created, 201)
          : Promise.reject(new Error('unexpected')),
    });

    renderPage();
    const searchInput = screen.getByLabelText('Search');
    fireEvent.change(searchInput, { target: { value: 'diligence' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    await screen.findByText('No sources match your search');

    openCreateDialog();
    fillRequiredFields('New Source', 'Jane Doe, IT', 'new-folder');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('New Source')).toBeInTheDocument();
    expect(screen.getByLabelText('Search')).toHaveValue('');
  });

  it('clears an unapplied search draft, not just an applied one, when a source is created', async () => {
    const created = makeSource({ id: 'source-2', name: 'New Source', tracked: true });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      '/api/v1/sources': (init) =>
        init?.method === 'POST'
          ? jsonResponse(created, 201)
          : Promise.reject(new Error('unexpected')),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    // Typed but never applied — `q` reads back empty both before and after the create, leaving
    // the debounced draft with no applied change to re-sync from.
    const searchInput = screen.getByLabelText('Search');
    fireEvent.change(searchInput, { target: { value: 'diligence' } });

    openCreateDialog();
    fillRequiredFields('New Source', 'Jane Doe, IT', 'new-folder');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Search')).toHaveValue('');
  });

  it('offers the sync interval only while Tracked is set to Synced by a connector', async () => {
    stubFetch();

    renderPage();
    await screen.findByText('No sources yet');
    openCreateDialog();

    expect(screen.getByLabelText(/Sync interval \(minutes\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Catalogued only' }));
    expect(screen.queryByLabelText(/Sync interval \(minutes\)/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Synced by a connector' }));
    expect(screen.getByLabelText(/Sync interval \(minutes\)/)).toBeInTheDocument();
  });

  it('rejects a fractional sync interval before it reaches the server', async () => {
    const fetchMock = stubFetch();

    renderPage();
    await screen.findByText('No sources yet');
    openCreateDialog();
    fillRequiredFields('Deal Room Inbox', 'Jane Doe, IT', 'deal-room');
    fireEvent.change(screen.getByLabelText(/Sync interval \(minutes\)/), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    expect(
      await screen.findByText('Enter a whole number of minutes, greater than zero.', {
        selector: 'p',
      }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === '/api/v1/sources' && init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('lists the three missing required fields in the error summary', async () => {
    stubFetch();

    renderPage();
    await screen.findByText('No sources yet');
    openCreateDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    const summary = await screen.findByRole('heading', { name: 'There is a problem' });
    const summaryList = summary.closest('.error-summary')?.querySelector('.error-summary-list');
    expect(summaryList).not.toBeNull();
    expect(within(summaryList as HTMLElement).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByText('Name is required.', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Owner is required.', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Folder path is required.', { selector: 'p' })).toBeInTheDocument();
  });

  it('shows each Tracked radio on one row with its label', async () => {
    stubFetch();

    renderPage();
    await screen.findByText('No sources yet');
    openCreateDialog();

    for (const label of ['Synced by a connector', 'Catalogued only']) {
      const radio = screen.getByRole('radio', { name: label });
      // 1A's RadioGroup rebuild keeps a radio and its own label text in one wrapper, rather than
      // the legend text reading as a third option above two bare, unlabelled dots.
      expect(radio.closest('.radio-group-option')?.textContent).toContain(label);
    }
    expect(screen.queryByRole('radio', { name: 'Tracked' })).not.toBeInTheDocument();
  });

  it('names the Name field on a source-name conflict, not the page-level error', async () => {
    stubFetch({
      '/api/v1/sources': (init) =>
        init?.method === 'POST'
          ? jsonResponse(
              { message: "A source named 'Deal Room Inbox' already exists for this tenant" },
              409,
            )
          : Promise.reject(new Error('unexpected')),
    });

    renderPage();
    await screen.findByText('No sources yet');

    openCreateDialog();
    fillRequiredFields('Deal Room Inbox', 'Jane Doe, IT', 'deal-room');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    // The error is no longer announced via role="alert" — that announcement now happens by
    // moving focus to the error summary, and keeping the role here would double-announce. The
    // association through aria-describedby and aria-invalid is the part that still matters. The
    // same message also appears as a link in the error summary above the field — `selector: 'p'`
    // picks out the inline field error specifically, since that is the one aria-describedby names.
    const errorEl = await screen.findByText(
      "A source named 'Deal Room Inbox' already exists for this tenant",
      { exact: false, selector: 'p' },
    );
    expect(errorEl).toHaveTextContent('Error:');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const nameInput = screen.getByLabelText('Name');
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput.getAttribute('aria-describedby')).toContain(errorEl.id);
  });

  it('shows a failed source creation in the error summary, leaving the Name field unmarked', async () => {
    stubFetch({
      '/api/v1/sources': (init) =>
        init?.method === 'POST'
          ? jsonResponse({ message: 'Failed to create source' }, 500)
          : Promise.reject(new Error('unexpected')),
    });

    renderPage();
    await screen.findByText('No sources yet');

    openCreateDialog();
    fillRequiredFields('Deal Room Inbox', 'Jane Doe, IT', 'deal-room');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('Failed to create source')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('guards against a double submit between the click and the button becoming disabled', async () => {
    const created = makeSource({ id: 'source-9', name: 'Deal Room Inbox' });
    let trackedCall = 0;
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => {
        trackedCall += 1;
        return trackedCall === 1
          ? jsonResponse({ docs: [], count: 0 })
          : jsonResponse({ docs: [created], count: 1 });
      },
      '/api/v1/sources': (init) =>
        init?.method === 'POST'
          ? jsonResponse(created, 201)
          : Promise.reject(new Error('unexpected')),
    });

    renderPage();
    await screen.findByText('No sources yet');

    openCreateDialog();
    fillRequiredFields('Deal Room Inbox', 'Jane Doe, IT', 'deal-room');
    const button = screen.getByRole('button', { name: 'Add source' });
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByText('Deal Room Inbox');

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/v1/sources' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('closes the dialog and discards its values when Cancel is clicked', async () => {
    stubFetch();

    renderPage();
    await screen.findByText('No sources yet');

    openCreateDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Discarded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openCreateDialog();
    expect(screen.getByLabelText('Name')).toHaveValue('');
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

    fireEvent.click(await screen.findByRole('button', { name: 'Disable Deal Room Inbox' }));

    expect(
      await screen.findByRole('button', { name: 'Enable Deal Room Inbox' }),
    ).toBeInTheDocument();
    const toggleCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/sources/source-1' && init?.method === 'PATCH',
    );
    expect(toggleCall).toBeDefined();
    expect(JSON.parse((toggleCall?.[1] as RequestInit).body as string)).toEqual({
      enabled: false,
    });
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows the shared Saving… busy label while toggling, keeping the button named for its action', async () => {
    const source = makeSource({ enabled: true });
    let resolvePatch!: (res: Response) => void;
    const patch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1': () => patch,
    });

    renderPage();

    const toggle = await screen.findByRole('button', { name: 'Disable Deal Room Inbox' });
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveTextContent('Saving…'));
    expect(toggle).toHaveAccessibleName('Disable Deal Room Inbox');
    expect(toggle).toHaveAttribute('aria-busy', 'true');

    resolvePatch(jsonResponse({ ...source, enabled: false }));
    expect(
      await screen.findByRole('button', { name: 'Enable Deal Room Inbox' }),
    ).toBeInTheDocument();
  });

  it('shows an error when toggling a source fails', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1': () => jsonResponse({ message: 'Failed to update source' }, 500),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Disable Deal Room Inbox' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to update source');
    });
    expect(screen.getByRole('button', { name: 'Disable Deal Room Inbox' })).toBeInTheDocument();
  });

  it('starts a sync and links to the resulting workflow run', async () => {
    const source = makeSource();
    const run = makeRun({ status: 'completed' });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
      // The hook now polls the source itself, not just the sync loop's run — without this stub
      // every poll rejects and surfaces a spurious sync-error alert.
      '/api/v1/sources/source-1': () => jsonResponse(source),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now, Deal Room Inbox' }));

    const link = await screen.findByRole('link', { name: 'Sync loop stopped' });
    expect(link).toHaveAttribute('href', '/workflow-runs/run-1');

    fireEvent.click(link);
    expect(await screen.findByText('run page probe')).toBeInTheDocument();
  });

  it('shows an error when the sync request fails, without blocking further attempts', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () =>
        jsonResponse({ message: 'Sync already in progress' }, 409),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now, Deal Room Inbox' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Sync already in progress');
    expect(screen.getByRole('button', { name: 'Sync now, Deal Room Inbox' })).not.toBeDisabled();
  });

  it('keeps polling and shows the loop label while a sweep is still running', async () => {
    const source = makeSource();
    const run = makeRun({ status: 'running' });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
      // Unchanged lastSyncAt on every poll — the sweep never settles.
      '/api/v1/sources/source-1': () => jsonResponse(source),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now, Deal Room Inbox' }));

    expect(await screen.findByText('Syncing')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Sync loop running' })).toBeInTheDocument();
  });

  it('refreshes the row once the sweep advances lastSyncAt', async () => {
    const source = makeSource();
    const run = makeRun({ status: 'running' });
    const advanced = makeSource({
      lastSyncAt: new Date(Date.now() + 1000).toISOString(),
      lastSyncStatus: 'ok',
    });
    let trackedCall = 0;
    let getCall = 0;
    stubFetch({
      [TRACKED_URL]: () => {
        trackedCall += 1;
        return jsonResponse({ docs: [trackedCall === 1 ? source : advanced], count: 1 });
      },
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
      '/api/v1/sources/source-1': () => {
        getCall += 1;
        // The first read still carries the pre-request timestamp; only the second reflects a
        // sweep that finished after `startSync` recorded its own `requestedAt`.
        return jsonResponse(getCall === 1 ? source : advanced);
      },
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now, Deal Room Inbox' }));

    // The settled sweep bumps the page's reload key, which is what actually moves the badge — the
    // row itself never patches its own `source` prop from the poll.
    expect(await screen.findByText('Synced')).toBeInTheDocument();
  });

  it('stops polling after the cap and says the loop keeps running', async () => {
    vi.useFakeTimers();
    const source = makeSource();
    const run = makeRun({ status: 'running' });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
      '/api/v1/sources/source-1': () => jsonResponse(source),
    });

    renderPage(['/sources'], 20_000);
    await tick();

    fireEvent.click(screen.getByRole('button', { name: 'Sync now, Deal Room Inbox' }));
    await tick();
    expect(screen.getByText('Syncing')).toBeInTheDocument();

    // SWEEP_POLL_CAP_MS is a module constant with no injection point — four 20s ticks safely
    // clear the 60s cap regardless of exactly when within a tick the deadline check runs.
    await tick(20_000);
    await tick(20_000);
    await tick(20_000);
    await tick(20_000);

    expect(screen.getByText('Still sweeping — the loop keeps running')).toBeInTheDocument();
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument();
  });

  it('ends the sweep at a 404 without saying the loop keeps running', async () => {
    vi.useFakeTimers();
    const source = makeSource();
    const run = makeRun({ status: 'running' });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      '/api/v1/sources/source-1/sync': () => jsonResponse(run, 201),
      '/api/v1/sources/source-1': () =>
        jsonResponse({ message: "Source 'source-1' not found" }, 404),
    });

    renderPage(['/sources'], 20_000);
    await tick();

    fireEvent.click(screen.getByRole('button', { name: 'Sync now, Deal Room Inbox' }));
    await tick();
    expect(screen.getByText('Syncing')).toBeInTheDocument();

    // A 404 ends the sweep at once — the source is gone, so no later poll will settle it — and
    // that is a different outcome from the cap simply passing on a source that still exists.
    await tick(20_000);

    expect(screen.getByText("Source 'source-1' not found")).toBeInTheDocument();
    expect(screen.queryByText('Still sweeping — the loop keeps running')).not.toBeInTheDocument();
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument();
  });

  it('offers no sync action for a catalogued-only source', async () => {
    const source = makeSource({ tracked: false });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    await screen.findByText('Deal Room Inbox');
    expect(screen.getAllByText('Not synced by a connector.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Sync now/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable|Enable/ })).not.toBeInTheDocument();
  });

  it('names each row action by its source', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Sync now, Deal Room Inbox' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Deal Room Inbox' })).toBeInTheDocument();
  });

  it('re-fetches the tracked list from the server on an applied search, matching the pager to the filtered total', async () => {
    const filtered = makeSource({ id: 'source-2', name: 'Diligence Drive', path: 'diligence' });
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      [`${TRACKED_URL}&q=diligence`]: () => jsonResponse({ docs: [filtered], count: 1 }),
      [`${INVENTORY_URL}&q=diligence`]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    const searchInput = screen.getByLabelText('Search');
    fireEvent.change(searchInput, { target: { value: 'diligence' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(await screen.findByText('Diligence Drive')).toBeInTheDocument();
    expect(screen.queryByText('Deal Room Inbox')).not.toBeInTheDocument();
    // The Pager's count is the server's filtered total, not the combined tenant total.
    expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
  });

  it('shows a search-specific empty state distinct from "no sources yet", and clears back to the full list', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      [`${TRACKED_URL}&q=nonexistent`]: () => jsonResponse({ docs: [], count: 0 }),
      [`${INVENTORY_URL}&q=nonexistent`]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    const searchInput = screen.getByLabelText('Search');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(await screen.findByText('No sources match your search')).toBeInTheDocument();
    expect(screen.queryByText('No sources yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
  });

  it('filters the tracked list to failed sources', async () => {
    const source = makeSource();
    const failedUrl =
      '/api/v1/sources?skip=0&limit=25&tracked=true&lastSyncStatus=failed&sort=name&sortDir=asc';
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      [failedUrl]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Failed only' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === failedUrl)).toBe(true);
    });
  });

  it('names Failed only, not search, in the tracked empty state when only it is applied', async () => {
    const failedUrl =
      '/api/v1/sources?skip=0&limit=25&tracked=true&lastSyncStatus=failed&sort=name&sortDir=asc';
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      [failedUrl]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Failed only' }));

    expect(await screen.findByText('No sources match your Failed only filter')).toBeInTheDocument();
  });

  it('does not treat Failed only as a filter on the inventory view', async () => {
    const failedUrl =
      '/api/v1/sources?skip=0&limit=25&tracked=true&lastSyncStatus=failed&sort=name&sortDir=asc';
    stubFetch({
      [failedUrl]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      [INVENTORY_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage(['/sources?failed=1']);
    await screen.findByText('Deal Room Inbox');

    fireEvent.click(screen.getByRole('button', { name: 'Repository inventory' }));

    expect(await screen.findByText('No inventory-only repositories yet')).toBeInTheDocument();
    expect(screen.queryByText('No repositories match your search')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('applies the search 300 ms after typing stops, and at once on Enter', async () => {
    vi.useFakeTimers();
    const debouncedUrl = `${TRACKED_URL}&q=diligence`;
    const enterUrl = `${TRACKED_URL}&q=drive`;
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      [debouncedUrl]: () => jsonResponse({ docs: [], count: 0 }),
      [`${INVENTORY_URL}&q=diligence`]: () => jsonResponse({ docs: [], count: 0 }),
      [enterUrl]: () => jsonResponse({ docs: [], count: 0 }),
      [`${INVENTORY_URL}&q=drive`]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await tick();

    const searchInput = screen.getByLabelText('Search');
    fireEvent.change(searchInput, { target: { value: 'diligence' } });
    await tick(299);
    expect(fetchMock.mock.calls.some(([url]) => url === debouncedUrl)).toBe(false);

    await tick(1);
    expect(fetchMock.mock.calls.some(([url]) => url === debouncedUrl)).toBe(true);

    fireEvent.change(searchInput, { target: { value: 'drive' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    await tick(0);
    expect(fetchMock.mock.calls.some(([url]) => url === enterUrl)).toBe(true);
  });

  it('clears the search via its own clear control at once, not the previous render’s stale draft', async () => {
    const filteredUrl = `${TRACKED_URL}&q=diligence`;
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      [filteredUrl]: () => jsonResponse({ docs: [], count: 0 }),
      [`${INVENTORY_URL}&q=diligence`]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');
    const searchInput = screen.getByLabelText('Search');
    fireEvent.change(searchInput, { target: { value: 'diligence' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    await screen.findByText('No sources match your search');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(searchInput).toHaveValue('');
    expect(fetchMock.mock.calls.filter(([url]) => url === TRACKED_URL).length).toBeGreaterThan(1);
  });

  it('clears an unapplied search draft and its timer on Clear filters, with Failed only as the sole applied filter', async () => {
    vi.useFakeTimers();
    const failedUrl =
      '/api/v1/sources?skip=0&limit=25&tracked=true&lastSyncStatus=failed&sort=name&sortDir=asc';
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      [failedUrl]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await tick();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Failed only' }));
    await tick();

    // Typed but never applied — the search stays the default, so Clear filters leaves the URL's
    // `q` unchanged and must reset the draft itself.
    const searchInput = screen.getByLabelText('Search');
    fireEvent.change(searchInput, { target: { value: 'dil' } });

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(searchInput).toHaveValue('');

    await tick(1_000);
    expect(fetchMock.mock.calls.some(([url]) => url.includes('q=dil'))).toBe(false);
  });

  it('sends the chosen page size as limit', async () => {
    const source = makeSource();
    const largerPageUrl = '/api/v1/sources?skip=0&limit=50&tracked=true&sort=name&sortDir=asc';
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      [largerPageUrl]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), {
      target: { value: '50' },
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === largerPageUrl)).toBe(true);
    });
  });

  it('clamps an out-of-range limit and a negative or non-numeric skip to the defaults', async () => {
    const fetchMock = stubFetch();

    renderPage(['/sources?limit=7&skip=-1&invSkip=x']);

    expect(await screen.findByText('No sources yet')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === TRACKED_URL)).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === INVENTORY_URL)).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    const source = makeSource();
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage(['/sources?sort=bogus&sortDir=up']);

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === TRACKED_URL)).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces the active view’s count once a filter settles, staying silent on first load', async () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [makeSource()], count: 1 }),
      [`${TRACKED_URL}&q=diligence`]: () => jsonResponse({ docs: [], count: 0 }),
      [`${INVENTORY_URL}&q=diligence`]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    const searchInput = await screen.findByLabelText('Search');
    await screen.findByText('Deal Room Inbox');
    expect(listener).not.toHaveBeenCalled();

    fireEvent.change(searchInput, { target: { value: 'diligence' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    await screen.findByText('No sources match your search');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('0 sources');
  });

  it('sorts the tracked list by a column on click, defaulting to descending, and resets to the first page', async () => {
    const source = makeSource();
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 30 }),
      '/api/v1/sources?skip=0&limit=25&tracked=true&sort=owner&sortDir=desc': () =>
        jsonResponse({ docs: [source], count: 30 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // The skip=25 request this triggers is unstubbed and rejects, so the count stays the stale
    // 30 from the initial load while the skip the Pager renders from has already advanced.
    await screen.findByText('26–30 of 30');

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Owner' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/sources?skip=0&limit=25&tracked=true&sort=owner&sortDir=desc',
        ),
      ).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('has no sortable header for Files — fileCount is computed, not stored, so the server ignores that query', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    expect(screen.queryByRole('button', { name: /Sort by Files/ })).not.toBeInTheDocument();
  });

  it('resets an active lastSyncAt sort to the default when switching to the inventory view', async () => {
    const source = makeSource();
    const fetchMock = stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 1 }),
      [INVENTORY_URL]: () => jsonResponse({ docs: [source], count: 1 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Last sync' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url === '/api/v1/sources?skip=0&limit=25&tracked=true&sort=lastSyncAt&sortDir=desc',
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Repository inventory' }));

    // Landing on the inventory view re-fetches it under the default sort, not the carried
    // `lastSyncAt` — that column has no header there.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === INVENTORY_URL)).toBe(true);
    });
    expect(screen.queryByRole('button', { name: /Sort by Last sync/ })).not.toBeInTheDocument();
  });

  it('reproduces a deep-linked view, search, sort and page, sending q to the server', async () => {
    const source = makeSource({ id: 'source-3', name: 'Export Drop', tracked: false });
    stubFetch({
      '/api/v1/sources?skip=20&limit=25&tracked=false&sort=owner&sortDir=asc&q=export': () =>
        jsonResponse({ docs: [source], count: 30 }),
    });

    renderPage(['/sources?view=inventory&q=export&sort=owner&sortDir=asc&skip=0&invSkip=20']);

    await screen.findByText('Export Drop');
    expect(screen.getByLabelText('Search')).toHaveValue('export');
    expect(screen.getByRole('button', { name: 'Repository inventory' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('keeps the address bar clean at every default, and reflects the tracked skip after paging', async () => {
    const source = makeSource();
    stubFetch({
      [TRACKED_URL]: () => jsonResponse({ docs: [source], count: 30 }),
      '/api/v1/sources?skip=25&limit=25&tracked=true&sort=name&sortDir=asc': () =>
        jsonResponse({ docs: [source], count: 30 }),
    });

    renderPage();
    await screen.findByText('Deal Room Inbox');

    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent('?skip=25');
    });
  });

  it('a member cannot reach the create dialog — the New source action does not render at all', async () => {
    stubFetch({}, () => jsonResponse(member));

    renderPage();

    await screen.findByText('No sources yet');
    expect(screen.queryByRole('button', { name: 'New source' })).not.toBeInTheDocument();
  });

  it('tells a member why New source is missing', async () => {
    stubFetch({}, () => jsonResponse(member));

    renderPage();

    expect(
      await screen.findByText('Adding or enabling a source requires an admin.'),
    ).toBeInTheDocument();
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
    expect(
      screen.queryByRole('button', { name: 'Disable Deal Room Inbox' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now, Deal Room Inbox' })).toBeInTheDocument();
  });

  it('withholds the New source action until the session probe resolves, then admits the admin', async () => {
    let resolveMe: (res: Response) => void;
    const pendingMe = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });
    stubFetch({}, () => pendingMe);

    renderPage();

    await screen.findByText('No sources yet');
    expect(screen.queryByRole('button', { name: 'New source' })).not.toBeInTheDocument();

    act(() => {
      resolveMe!(jsonResponse(admin));
    });

    expect(await screen.findByRole('button', { name: 'New source' })).toBeInTheDocument();
  });
});
