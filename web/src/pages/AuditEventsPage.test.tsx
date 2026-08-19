import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../App';
import { clearSession } from '../lib/auth';
import AuditEventsPage from './AuditEventsPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <AuditEventsPage />
    </MemoryRouter>,
  );
}

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

// Dispatches by URL, matching ApprovalsPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, () => Response>): void {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('AuditEventsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists audit events with actor, action, subject, correlation id and timestamp', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25': () => jsonResponse({ docs: [event], count: 1 }),
    });

    renderPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    expect(await screen.findByText('document.deleted')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('Document doc-1')).toBeInTheDocument();
    expect(screen.getByText('corr-1')).toBeInTheDocument();
    expect(screen.getByText(new Date(event.timestamp).toLocaleString())).toBeInTheDocument();
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

  it('renders an mcp-origin row with the MCP badge, its tool name, and the refusal reason', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25': () =>
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
      '/api/v1/audit-events?skip=0&limit=25': () =>
        jsonResponse({ docs: [classDriftEvent], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('sources.class_drift_applied')).toBeInTheDocument();
    expect(screen.getByText('400 documents modified')).toBeInTheDocument();
  });

  it('links a subject with a detail route, and leaves one without a route as plain text', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25': () =>
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
      '/api/v1/audit-events?skip=0&limit=25': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No audit events match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error when the audit log fails to load', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25': () =>
        jsonResponse({ message: 'Audit log unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Audit log unavailable');
  });

  it('applies the action, entity type and entity id filters as query parameters, not client-side', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&entityType=Document&entityId=doc-1'
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
          '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&entityType=Document&entityId=doc-1',
      ),
    ).toBe(true);
  });

  it('applies the origin and refusal reason filters as query parameters', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [mcpRefusalEvent], count: 1 }));
      }
      if (url === '/api/v1/audit-events?skip=0&limit=25&origin=mcp&refusalReason=authz-denied') {
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
          url === '/api/v1/audit-events?skip=0&limit=25&origin=mcp&refusalReason=authz-denied',
      ),
    ).toBe(true);
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 30 }));
      }
      if (url === '/api/v1/audit-events?skip=25&limit=25') {
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
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/audit-events?skip=25&limit=25'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('admits an admin to the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/audit-events?skip=0&limit=25': () => jsonResponse({ docs: [event], count: 1 }),
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
