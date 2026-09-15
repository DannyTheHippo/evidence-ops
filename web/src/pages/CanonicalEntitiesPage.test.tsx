import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../AuthenticatedRoutes';
import { clearSession } from '../lib/auth';
import CanonicalEntitiesPage from './CanonicalEntitiesPage';

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

const northgate = {
  id: 'entity-1',
  canonicalName: 'Northgate Plaza',
  aliases: ['Northgate', 'Northgate Shopping Center'],
  harvestedAliases: [],
  createdAt: '2026-07-01T00:00:00.000Z',
};

const southpark = {
  id: 'entity-2',
  canonicalName: 'Southpark Commons',
  aliases: [],
  harvestedAliases: [],
  createdAt: '2026-07-02T00:00:00.000Z',
};

// Dispatches by URL.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

// Exposes the current query string as accessible text, since `MemoryRouter` gives a test no other
// way to read it — proves the URL round-trip without reaching into router internals, matching
// AnswersPage.test.tsx.
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current search">{location.search}</output>;
}

function renderPage(initialEntries: string[] = ['/canonical-entities']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <CanonicalEntitiesPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('CanonicalEntitiesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists registered entities with their aliases, and "No aliases" for one with none', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ docs: [northgate, southpark], count: 2 }),
    });

    renderPage();

    expect(await screen.findByText('Northgate Plaza')).toBeInTheDocument();
    expect(screen.getByText('Northgate, Northgate Shopping Center')).toBeInTheDocument();
    expect(screen.getByText('Southpark Commons')).toBeInTheDocument();
    expect(screen.getByText('No aliases')).toBeInTheDocument();

    expect(
      screen.getByRole('region', { name: 'Alias groups and the names they resolve to' }),
    ).toHaveAttribute('tabindex', '0');
  });

  it('renders the proposals queue above the table, with no toolbar row on this page', async () => {
    const proposedAlias = {
      alias: 'Northgate Plz',
      status: 'proposed' as const,
      quote: 'Northgate Plz reported NOI of $1.2M.',
      locator: { kind: 'pdf-page' as const, page: 2, extractorVersion: 'pdf-1' },
      documentVersionId: 'version-1',
      harvestedAt: '2026-07-02T00:00:00.000Z',
    };
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({
          docs: [{ ...northgate, harvestedAliases: [proposedAlias] }],
          count: 1,
        }),
    });

    renderPage();

    const queueHeading = await screen.findByRole('heading', { name: 'Proposed aliases' });
    const tableRegion = screen.getByRole('region', {
      name: 'Alias groups and the names they resolve to',
    });

    // jsdom cannot see layout, so `compareDocumentPosition` is the only signal available — the
    // queue precedes the table in `document.body`.
    expect(
      queueHeading.compareDocumentPosition(tableRegion) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // This page passes neither `view` nor `filters` to `RecordListPage`, so `Toolbar` renders
    // nothing at all — the queue sits beside the table, never inside a toolbar row.
    expect(document.querySelector('.toolbar')).toBeNull();
  });

  it('renders an empty state when nothing is registered, and only one', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No alias groups registered yet')).toBeInTheDocument();
    // The proposals queue is omitted entirely rather than mounting its own empty state beside
    // this one — a registry with no entities can carry no proposals either.
    expect(screen.queryByText('No proposals to review')).not.toBeInTheDocument();
  });

  it('shows a load error verbatim, but leaves an already-loaded row on screen on a later refresh failure', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ message: 'Alias registry unavailable' }, 500));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    // Already the active, ascending column — one click toggles it to descending, which is the
    // request that fails.
    fireEvent.click(
      screen.getByRole('button', { name: 'Sort by Canonical name, sorted ascending' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Alias registry unavailable');
    // `RecordListPage` takes `error` separately from `status` — a failed refresh leaves the rows
    // already on screen rather than blanking them.
    expect(screen.getByText('Northgate Plaza')).toBeInTheDocument();
  });

  it('shows a blank error state, with no rows, on a first-load failure', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ message: 'Alias registry unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Alias registry unavailable');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('creates a new entity from the Add entity dialog, reloading rather than prepending it', async () => {
    const created = {
      id: 'entity-3',
      canonicalName: 'Riverside Tower',
      aliases: ['Riverside'],
      harvestedAliases: [],
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    // A create reloads through `load()` instead of splicing the new row into local state, so the
    // list URL is fetched twice — once on mount, once after the create — and the second response
    // is the one that carries the new row, in sort order rather than prepended.
    let listCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? jsonResponse({ docs: [northgate], count: 1 })
            : jsonResponse({ docs: [northgate, created], count: 2 }),
        );
      }
      if (url === '/api/v1/canonical-entities' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(created, 201));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));
    const dialog = screen.getByRole('dialog', { name: 'Add alias group' });

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Riverside Tower' },
    });
    fireEvent.change(screen.getByLabelText('Aliases (optional)'), {
      target: { value: 'Riverside' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entity' }));

    expect(await screen.findByText('Riverside Tower')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(listCalls).toBe(2);
  });

  it('opens the Add entity dialog from an empty registry, and a save creates the first entity', async () => {
    const created = {
      id: 'entity-3',
      canonicalName: 'Riverside Tower',
      aliases: [],
      harvestedAliases: [],
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    let listCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? jsonResponse({ docs: [], count: 0 })
            : jsonResponse({ docs: [created], count: 1 }),
        );
      }
      if (url === '/api/v1/canonical-entities' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(created, 201));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No alias groups registered yet');

    // The empty state renders no `RecordListPage` children, so the dialog has to mount outside
    // them for the header's Add entity action to open it here.
    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));
    const dialog = screen.getByRole('dialog', { name: 'Add alias group' });

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Riverside Tower' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entity' }));

    expect(await screen.findByText('Riverside Tower')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]: [string, RequestInit?]) =>
          url === '/api/v1/canonical-entities' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('requests the page size chosen in the pager', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url ===
          '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc' ||
        url ===
          '/api/v1/canonical-entities?skip=0&limit=50&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url ===
            '/api/v1/canonical-entities?skip=0&limit=50&sort=canonicalNameNormalized&sortDir=asc',
        ),
      ).toBe(true);
    });
  });

  it('clamps a negative skip in the URL to zero', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ docs: [northgate], count: 1 }),
    });

    renderPage(['/canonical-entities?skip=-1']);

    expect(await screen.findByText('Northgate Plaza')).toBeInTheDocument();
  });

  it('falls back to the default page size for an out-of-range one in the URL', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ docs: [northgate], count: 1 }),
    });

    renderPage(['/canonical-entities?limit=7']);

    await screen.findByText('Northgate Plaza');
    expect(screen.getByLabelText('Rows per page')).toHaveValue('25');
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ docs: [northgate], count: 1 }),
    });

    renderPage(['/canonical-entities?sort=bogus&sortDir=up']);

    expect(await screen.findByText('Northgate Plaza')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Canonical name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('edits an existing entity from its row', async () => {
    const updated = { ...northgate, canonicalName: 'Northgate Plaza II' };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      if (url === '/api/v1/canonical-entities/entity-1' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse(updated));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    const row = screen.getByText('Northgate Plaza').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('dialog', { name: 'Edit "Northgate Plaza"' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Northgate Plaza II' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Northgate Plaza II')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a duplicate-name 409 verbatim and leaves the list unchanged', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      if (url === '/api/v1/canonical-entities' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ message: 'An alias group named "Northgate Plaza" already exists' }, 409),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));
    const dialog = screen.getByRole('dialog', { name: 'Add alias group' });
    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Northgate Plaza' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entity' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An alias group named "Northgate Plaza" already exists',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The list stays untouched by the rejected create — still just the one seeded row.
    expect(screen.getAllByRole('row')).toHaveLength(2); // header row + the one seeded entity
  });

  it('confirms before deleting through ConfirmDialog, then removes the row', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate, southpark], count: 2 }));
      }
      if (url === '/api/v1/canonical-entities/entity-1' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    const row = screen.getByText('Northgate Plaza').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

    expect(screen.getByRole('dialog', { name: 'Delete "Northgate Plaza"?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));

    await waitFor(() => expect(screen.queryByText('Northgate Plaza')).not.toBeInTheDocument());
    expect(screen.getByText('Southpark Commons')).toBeInTheDocument();
  });

  it('marks the confirm button busy once the delete is in flight, so a double click fires only one request', async () => {
    let resolveDelete: (() => void) | undefined;
    const deletePending = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      if (url === '/api/v1/canonical-entities/entity-1' && init?.method === 'DELETE') {
        return deletePending.then(() => new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    const row = screen.getByText('Northgate Plaza').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const confirmButton = screen.getByRole('button', { name: 'Delete entity' });

    fireEvent.click(confirmButton);
    // Reflects `busy` immediately, before the pending request settles.
    expect(screen.getByRole('button', { name: 'Delete entity…' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity…' }));

    resolveDelete?.();
    await waitFor(() => expect(screen.queryByText('Northgate Plaza')).not.toBeInTheDocument());

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]: [string, RequestInit?]) =>
          url === '/api/v1/canonical-entities/entity-1' && init?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });

  it('moves focus off the deleted row instead of dropping it to the body', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate, southpark], count: 2 }));
      }
      if (
        (url === '/api/v1/canonical-entities/entity-1' ||
          url === '/api/v1/canonical-entities/entity-2') &&
        init?.method === 'DELETE'
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    const tableRegion = screen.getByRole('region', {
      name: 'Alias groups and the names they resolve to',
    });
    const firstRow = screen.getByText('Northgate Plaza').closest('tr')!;
    const firstDelete = within(firstRow).getByRole('button', { name: 'Delete' });
    // Focused before the dialog opens, so the dialog captures it as the element to restore to —
    // which is the button this delete is about to detach.
    firstDelete.focus();
    fireEvent.click(firstDelete);
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));

    // The Delete button `ConfirmDialog` was opened from left with its row, so the page moves focus
    // to the table's own region rather than leaving it on `body`.
    await waitFor(() => expect(tableRegion).toHaveFocus());

    const lastRow = screen.getByText('Southpark Commons').closest('tr')!;
    const lastDelete = within(lastRow).getByRole('button', { name: 'Delete' });
    lastDelete.focus();
    fireEvent.click(lastDelete);
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));

    // The table unmounts with its last row, leaving the page's primary action as the target.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add entity' })).toHaveFocus());
  });

  it('steps back a page when the last entity on a later page is deleted', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (
        url ===
        '/api/v1/canonical-entities?skip=25&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [southpark], count: 26 }));
      }
      if (url === '/api/v1/canonical-entities/entity-2' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (
        url ===
        '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 25 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/canonical-entities?skip=25']);
    await screen.findByText('Southpark Commons');

    const row = screen.getByText('Southpark Commons').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));

    await screen.findByText('Northgate Plaza');
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('toggles the active, ascending-by-default sort column on click, reading the normalised field', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url ===
          '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc' ||
        url ===
          '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('Northgate Plaza');

    // Already the active, ascending column — a click toggles direction rather than restarting at
    // descending, since it is also the default.
    fireEvent.click(
      screen.getByRole('button', { name: 'Sort by Canonical name, sorted ascending' }),
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url ===
            '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=desc',
        ),
      ).toBe(true);
    });
  });

  it('reproduces a sorted, paged view from a deep link, and reload preserves it with a clean address bar at defaults', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=25&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [southpark], count: 30 }),
    });

    renderPage(['/canonical-entities?sort=createdAt&sortDir=desc&skip=25']);

    await screen.findByText('Southpark Commons');
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      'sort=createdAt',
    );
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent('skip=25');
  });

  it('keeps the URL clean when sort and paging sit at their defaults', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ docs: [northgate], count: 1 }),
    });

    renderPage();

    await screen.findByText('Northgate Plaza');
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('admits an admin to the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/canonical-entities?skip=0&limit=25&sort=canonicalNameNormalized&sortDir=asc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    render(
      <MemoryRouter initialEntries={['/canonical-entities']}>
        <Routes>
          <Route
            path="/canonical-entities"
            element={
              <RequireAdmin>
                <CanonicalEntitiesPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Aliases and entities' }),
    ).toBeInTheDocument();
  });

  it('shows a member the 403 view for the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
    });

    render(
      <MemoryRouter initialEntries={['/canonical-entities']}>
        <Routes>
          <Route path="/" element={<p>home probe</p>} />
          <Route
            path="/canonical-entities"
            element={
              <RequireAdmin>
                <CanonicalEntitiesPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access to this page" }),
    ).toBeInTheDocument();
    expect(screen.queryByText('home probe')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Aliases and entities' })).not.toBeInTheDocument();
  });
});
