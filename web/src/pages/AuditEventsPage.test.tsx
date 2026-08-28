import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../AuthenticatedRoutes';
import { clearSession } from '../lib/auth';
import AuditEventsPage from './AuditEventsPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL, matching AnswersPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, () => Response>): void {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
}

// Exposes the current query string as accessible text, since `MemoryRouter` gives a test no other
// way to read it — proves the URL round-trip without reaching into router internals.
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current search">{location.search}</output>;
}

function renderPage(initialEntries: string[] = ['/audit-events']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuditEventsPage />
      <LocationProbe />
    </MemoryRouter>,
  );
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

const event = {
  id: 'event-1',
  actor: 'admin@example.com',
  action: 'document.deleted',
  subject: { entityType: 'Document', entityId: 'doc-1' },
  timestamp: '2026-08-01T12:00:00.000Z',
  correlationId: 'corr-1',
  createdAt: '2026-08-01T12:00:00.000Z',
  origin: 'api' as const,
};

// `timestamp` and `createdAt` diverge — the case the "Recorded" column's sub-line exists for.
const delayedEvent = {
  id: 'event-5',
  actor: 'admin@example.com',
  action: 'workflow.completed',
  subject: { entityType: 'WorkflowRun', entityId: 'run-1' },
  timestamp: '2026-08-01T11:00:00.000Z',
  correlationId: 'corr-5',
  createdAt: '2026-08-01T11:05:00.000Z',
  origin: 'api' as const,
};

// ApiKey carries no detail route in the SPA, unlike Document — the two events together prove the
// subject cell links only when a route actually exists.
const unroutedEvent = {
  id: 'event-2',
  actor: 'admin@example.com',
  action: 'apiKey.revoked',
  subject: { entityType: 'ApiKey', entityId: 'key-1' },
  timestamp: '2026-08-01T13:00:00.000Z',
  correlationId: 'corr-2',
  createdAt: '2026-08-01T13:00:00.000Z',
  origin: 'api' as const,
};

const classDriftEvent = {
  id: 'event-4',
  actor: 'admin@example.com',
  action: 'sources.class_drift_applied',
  subject: { entityType: 'Source', entityId: 'source-1' },
  timestamp: '2026-08-01T15:00:00.000Z',
  correlationId: 'corr-4',
  createdAt: '2026-08-01T15:00:00.000Z',
  origin: 'api' as const,
  modifiedCount: 400,
};

const mcpRefusalEvent = {
  id: 'event-3',
  actor: 'mcp-pat-holder@example.com',
  action: 'mcp.tool_call.refused',
  subject: { entityType: 'Answer', entityId: 'answer-1' },
  timestamp: '2026-08-01T14:00:00.000Z',
  correlationId: 'corr-3',
  createdAt: '2026-08-01T14:00:00.000Z',
  origin: 'mcp' as const,
  toolName: 'get_answer',
  refusalReason: 'authz-denied',
};

describe('AuditEventsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists audit events with actor, action, subject, correlation id and recorded time', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event], count: 1 }),
    });

    renderPage();

    expect(screen.getByText('Loading audit events…')).toBeInTheDocument();

    expect(await screen.findByText('document.deleted')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('Document doc-1')).toBeInTheDocument();
    expect(screen.getByText('corr-1')).toBeInTheDocument();
    const table = screen.getByRole('table', {
      name: 'Audit events matching the current filters',
    });
    expect(table).toBeInTheDocument();
    // An api-origin row reads as muted plain text, not a badge — the badge is spent on the rarer
    // mcp case. Scoped to the table because the Origin filter's own <option> labels carry both of
    // these strings, so an unscoped query matches the filter as well as the cell.
    expect(within(table).getByText('api')).toBeInTheDocument();
    expect(within(table).queryByText('MCP')).not.toBeInTheDocument();
  });

  it('shows when a record was recorded versus when the underlying action occurred, only if they differ', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event, delayedEvent], count: 2 }),
    });

    renderPage();
    await screen.findByText('document.deleted');

    const sameRow = screen.getByText('document.deleted').closest('tr');
    const divergedRow = screen.getByText('workflow.completed').closest('tr');
    if (!sameRow || !divergedRow) throw new Error('row not found');

    // `event.timestamp` equals `event.createdAt` — no second line.
    expect(within(sameRow).queryByText('Occurred', { exact: false })).not.toBeInTheDocument();
    // `delayedEvent.timestamp` precedes `delayedEvent.createdAt` by five minutes — both render.
    expect(within(divergedRow).getByText('Occurred', { exact: false })).toBeInTheDocument();
  });

  it('renders an mcp-origin row with the MCP badge, its tool name, and the refusal reason', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [mcpRefusalEvent], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('mcp.tool_call.refused')).toBeInTheDocument();
    // Same scoping reason as above: 'MCP', 'api' and every refusal reason are also <option>
    // labels on the filter form, so only a table-scoped query proves the *cell* rendered them.
    const table = screen.getByRole('table', {
      name: 'Audit events matching the current filters',
    });
    expect(within(table).getByText('MCP')).toBeInTheDocument();
    expect(within(table).getByText('get_answer')).toBeInTheDocument();
    expect(within(table).getByText('authz-denied')).toBeInTheDocument();
    expect(within(table).queryByText('api')).not.toBeInTheDocument();
  });

  it('renders the count of documents a class-drift remedy rewrote, stacked under the action', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [classDriftEvent], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('sources.class_drift_applied')).toBeInTheDocument();
    expect(screen.getByText('400 documents modified')).toBeInTheDocument();
  });

  it('links a subject with a detail route, and leaves one without a route as plain text', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event, unroutedEvent], count: 2 }),
    });

    renderPage();
    await screen.findByText('document.deleted');

    expect(screen.getByRole('link', { name: 'Document doc-1' })).toHaveAttribute(
      'href',
      '/documents/doc-1',
    );
    expect(screen.getByText('ApiKey key-1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'ApiKey key-1' })).not.toBeInTheDocument();
  });

  it('reads as empty when no events match', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No matching audit events')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error when the audit log fails to load', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ message: 'Audit log unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Audit log unavailable');
  });

  it('keeps already-loaded rows on screen when a later refresh fails, rather than blanking them', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=action&sortDir=desc') {
        return Promise.resolve(jsonResponse({ message: 'Audit log unavailable' }, 500));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Action' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Audit log unavailable');
    expect(screen.getByText('document.deleted')).toBeInTheDocument();
  });

  it('applies the action, entity type and entity id filters as query parameters, not client-side', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&entityType=Document&entityId=doc-1&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document.deleted' } });
    fireEvent.change(screen.getByLabelText('Entity type'), { target: { value: 'Document' } });
    fireEvent.change(screen.getByLabelText('Entity id'), { target: { value: 'doc-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await screen.findByText('document.deleted');

    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url ===
          '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&entityType=Document&entityId=doc-1&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
  });

  it('applies the origin and refusal reason filters as query parameters', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [mcpRefusalEvent], count: 1 }));
      }
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&origin=mcp&refusalReason=authz-denied&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [mcpRefusalEvent], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('mcp.tool_call.refused');

    fireEvent.change(screen.getByLabelText('Origin'), { target: { value: 'mcp' } });
    fireEvent.change(screen.getByLabelText('Refusal reason'), {
      target: { value: 'authz-denied' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await screen.findByText('mcp.tool_call.refused');

    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url ===
          '/api/v1/audit-events?skip=0&limit=25&origin=mcp&refusalReason=authz-denied&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
  });

  it('filters to a subject by clicking its row action, without pasting an id', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [event, unroutedEvent], count: 2 }));
      }
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&entityType=Document&entityId=doc-1&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.click(screen.getByRole('button', { name: 'Filter to Document doc-1' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url ===
            '/api/v1/audit-events?skip=0&limit=25&entityType=Document&entityId=doc-1&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });
    // The filter form reflects what the click just applied, rather than reading stale.
    expect(screen.getByLabelText('Entity type')).toHaveValue('Document');
    expect(screen.getByLabelText('Entity id')).toHaveValue('doc-1');
  });

  it('resets paging to the first page in the same patch as applying a filter, and keeps the URL clean at defaults', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 30 }));
      }
      if (url === '/api/v1/audit-events?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(
          jsonResponse({ docs: [{ ...event, id: 'event-page-2' }], count: 30 }),
        );
      }
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('document.deleted');

    // A page at its defaults keeps a clean address bar.
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('30 total');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document.deleted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await screen.findByText('1 total');

    // The filter landed and paging reset to the first page in the same patch — the URL carries
    // only the non-default `action`, never a leftover `skip`.
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      '?action=document.deleted',
    );
  });

  it('reproduces a filtered, sorted, paged view from a deep link', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=25&limit=25&entityType=Document&entityId=doc-1&sort=action&sortDir=asc':
        () => jsonResponse({ docs: [event], count: 30 }),
    });

    renderPage([
      '/audit-events?entityType=Document&entityId=doc-1&sort=action&sortDir=asc&skip=25',
    ]);

    await screen.findByText('document.deleted');
    expect(screen.getByLabelText('Entity type')).toHaveValue('Document');
    expect(screen.getByLabelText('Entity id')).toHaveValue('doc-1');
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('sorts by a column on click, defaulting to descending and toggling on the active column, and never offers a sort on Actor', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc' ||
        url === '/api/v1/audit-events?skip=0&limit=25&sort=origin&sortDir=desc' ||
        url === '/api/v1/audit-events?skip=0&limit=25&sort=origin&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('document.deleted');

    expect(screen.queryByRole('button', { name: 'Sort by Actor' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Origin' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/audit-events?skip=0&limit=25&sort=origin&sortDir=desc',
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Origin, sorted descending' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/audit-events?skip=0&limit=25&sort=origin&sortDir=asc',
        ),
      ).toBe(true);
    });
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 30 }));
      }
      if (url === '/api/v1/audit-events?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [{ ...event, id: 'event-2' }], count: 30 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('document.deleted');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('30 total');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/audit-events?skip=25&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('admits an admin to the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event], count: 1 }),
    });

    render(
      <MemoryRouter initialEntries={['/audit-events']}>
        <Routes>
          <Route
            path="/audit-events"
            element={
              <RequireAdmin>
                <AuditEventsPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Audit Log')).toBeInTheDocument();
  });

  it('bounces a member away from the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
    });

    render(
      <MemoryRouter initialEntries={['/audit-events']}>
        <Routes>
          <Route path="/" element={<p>home probe</p>} />
          <Route
            path="/audit-events"
            element={
              <RequireAdmin>
                <AuditEventsPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('home probe')).toBeInTheDocument();
    expect(screen.queryByText('Audit Log')).not.toBeInTheDocument();
  });
});
