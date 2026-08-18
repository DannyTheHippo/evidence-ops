import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../App';
import { clearSession } from '../lib/auth';
import AuditEventsPage from './AuditEventsPage';

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

  it('lists audit events with actor, action, subject and timestamp', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25': () => jsonResponse({ docs: [event], count: 1 }),
    });

    render(<AuditEventsPage />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    expect(await screen.findByText('document.deleted')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('Document doc-1')).toBeInTheDocument();
    expect(screen.getByText(new Date(event.timestamp).toLocaleString())).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Audit events matching the current filters' }),
    ).toBeInTheDocument();
  });

  it('reads as empty when no events match', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25': () => jsonResponse({ docs: [], count: 0 }),
    });

    render(<AuditEventsPage />);

    expect(await screen.findByText('No audit events match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error when the audit log fails to load', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25': () =>
        jsonResponse({ message: 'Audit log unavailable' }, 500),
    });

    render(<AuditEventsPage />);

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

    render(<AuditEventsPage />);
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

    render(<AuditEventsPage />);
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
