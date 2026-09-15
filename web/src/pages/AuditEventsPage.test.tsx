import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../AuthenticatedRoutes';
import { clearAnnouncements, subscribeAnnouncements } from '../lib/announce';
import { clearSession } from '../lib/auth';
import { shortId } from '../lib/identifiers';
import AuditEventsPage from './AuditEventsPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// `AuditEventView.actor` is a stringified ObjectId on the wire (`AuditEvent.actor` schema field),
// never an email — these stand in for the two members whose actions the fixtures below record.
const ACTOR_ID = '65f1c2e4a1b2c3d4e5f6a7c1';
const MCP_ACTOR_ID = '65f1c2e4a1b2c3d4e5f6a7c2';

// Dispatches by URL, matching AnswersPage.test.tsx's stubFetch shape. Every page mount also fires
// the actor-lookup `/users` request, so that route is always present here and a caller wanting a
// different member list (or its failure) overrides this key like any other.
const DEFAULT_ROUTES: Record<string, () => Response> = {
  '/api/v1/users?limit=100': () =>
    jsonResponse({
      docs: [
        {
          id: ACTOR_ID,
          email: 'admin@example.com',
          role: 'admin',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: MCP_ACTOR_ID,
          email: 'mcp-pat-holder@example.com',
          role: 'member',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      count: 2,
    }),
};

function stubFetch(routes: Record<string, () => Response>): void {
  const merged = { ...DEFAULT_ROUTES, ...routes };
  const fetchMock = vi.fn((url: string) => {
    const handler = merged[url];
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

const DEFAULT_URL = '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc';
const VALID_ENTITY_ID = '65f1c2e4a1b2c3d4e5f6a7b8';
const ENTITY_ID_ERROR = 'Enter a 24-character id, or use the search icon beside a subject below.';

// Answers every audit-events request with `docs`, so a test that changes several filters in turn
// never renders an error for an intermediate request, and asserts the request it cares about.
function stubAnyAuditEvents(docs: unknown[]) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/v1/audit-events?')) {
      return Promise.resolve(jsonResponse({ docs, count: docs.length }));
    }
    const handler = DEFAULT_ROUTES[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function auditEventRequests(fetchMock: { mock: { calls: [string][] } }): string[] {
  return fetchMock.mock.calls
    .map(([url]) => url)
    .filter((url) => url.startsWith('/api/v1/audit-events?'));
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
  actor: ACTOR_ID,
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
  actor: ACTOR_ID,
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
  actor: ACTOR_ID,
  action: 'apiKey.revoked',
  subject: { entityType: 'ApiKey', entityId: 'key-1' },
  timestamp: '2026-08-01T13:00:00.000Z',
  correlationId: 'corr-2',
  createdAt: '2026-08-01T13:00:00.000Z',
  origin: 'api' as const,
};

const classDriftEvent = {
  id: 'event-4',
  actor: ACTOR_ID,
  action: 'sources.class_drift_applied',
  subject: { entityType: 'Source', entityId: 'source-1' },
  timestamp: '2026-08-01T15:00:00.000Z',
  correlationId: 'corr-4',
  createdAt: '2026-08-01T15:00:00.000Z',
  origin: 'api' as const,
  modifiedCount: 400,
};

// A 24-character, ObjectId-shaped correlation id — long enough for `shortId` to actually truncate
// it, which `corr-1`'s six characters never do.
const longCorrelationEvent = {
  id: 'event-6',
  actor: ACTOR_ID,
  action: 'document.deleted',
  subject: { entityType: 'Document', entityId: 'doc-9' },
  timestamp: '2026-08-01T16:00:00.000Z',
  correlationId: '650a1f2e3b4c5d6e7f809123',
  createdAt: '2026-08-01T16:00:00.000Z',
  origin: 'api' as const,
};

const mcpRefusalEvent = {
  id: 'event-3',
  actor: MCP_ACTOR_ID,
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
    clearAnnouncements();
  });

  it('lists audit events with actor, action, subject, correlation id and recorded time', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event], count: 1 }),
    });

    renderPage();

    expect(screen.getByText('Loading audit events…')).toBeInTheDocument();

    expect(await screen.findByText('document.deleted')).toBeInTheDocument();
    // The actor-lookup request races the audit-events request, so the resolved email can land
    // after the row itself does.
    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('Document doc-1')).toBeInTheDocument();
    expect(screen.getByText('corr-1')).toBeInTheDocument();
    const table = screen.getByRole('table', {
      name: 'Audit events matching the current filters',
    });
    expect(table).toBeInTheDocument();
    // An api-origin row reads as muted plain text, not a badge — the badge is spent on the rarer
    // mcp case. Scoped to the table because the Origin filter's own <option> labels carry both of
    // these strings, so an unscoped query matches the filter as well as the cell.
    expect(within(table).getByText('API')).toBeInTheDocument();
    expect(within(table).queryByText('MCP')).not.toBeInTheDocument();

    expect(
      screen.getByRole('region', { name: 'Audit events matching the current filters' }),
    ).toHaveAttribute('tabindex', '0');

    // No filter is applied, so no chip row renders at all.
    expect(screen.queryByRole('list', { name: 'Applied filters' })).not.toBeInTheDocument();
  });

  it('resolves an actor id to its email when the member is on the first page of users', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event], count: 1 }),
    });

    renderPage();
    await screen.findByText('document.deleted');

    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy actor id' })).not.toBeInTheDocument();
  });

  it('falls back to a short id and a copy control when the actor cannot be resolved', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event], count: 1 }),
      '/api/v1/users?limit=100': () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('document.deleted');

    expect(await screen.findByText(shortId(ACTOR_ID))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy actor id' })).toBeInTheDocument();
    expect(screen.queryByText('admin@example.com')).not.toBeInTheDocument();
  });

  it('keeps the table usable when the actor lookup fails', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [event], count: 1 }),
      '/api/v1/users?limit=100': () => jsonResponse({ message: 'Users unavailable' }, 500),
    });

    renderPage();
    await screen.findByText('document.deleted');

    expect(await screen.findByText(shortId(ACTOR_ID))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('renders an mcp-origin row with the MCP badge, its tool name, and the refusal reason, all in the Origin cell', async () => {
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
    const originCell = screen.getByText('get_answer').closest('td');
    if (!originCell) throw new Error('origin cell not found');
    expect(within(originCell).getByText('MCP')).toBeInTheDocument();
    expect(within(originCell).getByText('get_answer')).toBeInTheDocument();
    expect(within(originCell).getByText('authz-denied')).toBeInTheDocument();
    expect(within(table).queryByText('API')).not.toBeInTheDocument();
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
    expect(screen.getByText('ApiKey key-1')).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('link', { name: 'ApiKey key-1' })).not.toBeInTheDocument();

    // The truncated subject and its filter action share a `.cell-truncate-action` row so the flex
    // layout keeps them on one line instead of the tooltip anchor's own `display: block` forcing a
    // break onto the next one.
    const subjectRow = screen
      .getByRole('link', { name: 'Document doc-1' })
      .closest('.cell-truncate-action');
    expect(subjectRow).not.toBeNull();
    expect(subjectRow).toContainElement(
      screen.getByRole('button', { name: 'Filter to Document doc-1' }),
    );
  });

  it('shows a short correlation id in mono but copies the full value to the clipboard', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [longCorrelationEvent], count: 1 }),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderPage();
    await screen.findByText('document.deleted');

    const table = screen.getByRole('table', {
      name: 'Audit events matching the current filters',
    });
    const correlationText = within(table).getByText('650a1f2e…');
    expect(correlationText).toHaveAttribute('tabindex', '0');
    expect(within(table).queryByText(longCorrelationEvent.correlationId)).not.toBeInTheDocument();
    const correlationRow = correlationText.closest('.cell-truncate-action');
    expect(correlationRow).not.toBeNull();
    expect(correlationRow).toContainElement(
      within(table).getByRole('button', { name: 'Copy correlation id' }),
    );

    fireEvent.click(within(table).getByRole('button', { name: 'Copy correlation id' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(longCorrelationEvent.correlationId);
    });
  });

  it('reads as an earned-zero state when no events have ever been recorded, with no filter to clear', async () => {
    stubFetch({
      '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc': () =>
        jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    const title = await screen.findByText('No audit events yet');
    expect(title).toBeInTheDocument();
    // The earned-zero-inbox treatment distinguishes "nothing has ever been recorded" from a
    // filter that simply matches nothing.
    expect(title.closest('.empty-state--zero')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it("offers Show all events from the empty state once a filter has narrowed the result to nothing, distinct from FilterBar's own Clear filters button", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&action=nothing.matches&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/audit-events?action=nothing.matches']);

    const title = await screen.findByText('No matching audit events');
    expect(title).toBeInTheDocument();
    expect(title.closest('.empty-state--zero')).toBeNull();
    // FilterBar's own "Clear filters" button is also on screen at this point — this asserts the
    // empty state's distinct action specifically.
    fireEvent.click(screen.getByRole('button', { name: 'Show all events' }));

    await screen.findByText('document.deleted');
    expect(screen.getByLabelText('Action')).toHaveValue('');
  });

  it('clears unapplied drafts in both text filters and their timers on Clear filters', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage(['/audit-events?origin=mcp']);
    await screen.findByText('document.deleted');
    vi.useFakeTimers();

    // Neither draft has applied yet: Action is still the default, and the entity id pattern
    // rejects `bad` before its own 300 ms timer has run.
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('Entity id'), { target: { value: 'bad' } });

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getByLabelText('Action')).toHaveValue('');
    expect(screen.getByLabelText('Entity id')).toHaveValue('');
    expect(screen.queryByText(ENTITY_ID_ERROR, { exact: false })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(auditEventRequests(fetchMock).some((url) => url.includes('action=abc'))).toBe(false);
    expect(auditEventRequests(fetchMock).some((url) => url.includes('entityId='))).toBe(false);
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

  it('applies the action, entity type and entity id filters as query parameters as they change, echoed as chips', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document.deleted' } });
    fireEvent.change(screen.getByLabelText('Entity type'), { target: { value: 'Document' } });
    fireEvent.change(screen.getByLabelText('Entity id'), {
      target: { value: VALID_ENTITY_ID },
    });

    await waitFor(() => {
      expect(auditEventRequests(fetchMock)).toContain(
        `/api/v1/audit-events?skip=0&limit=25&action=document.deleted&entityType=Document&entityId=${VALID_ENTITY_ID}&sort=createdAt&sortDir=desc`,
      );
    });
    expect(screen.queryByRole('button', { name: 'Apply filters' })).not.toBeInTheDocument();

    const chipRow = await screen.findByRole('list', { name: 'Applied filters' });
    expect(within(chipRow).getByText('Action: document.deleted')).toBeInTheDocument();
    expect(within(chipRow).getByText('Entity type: Document')).toBeInTheDocument();
    expect(within(chipRow).getByText('Entity id: 65f1c2e4…')).toBeInTheDocument();
  });

  it('applies the origin and refusal reason filters as query parameters on change, echoed as chips', async () => {
    const fetchMock = stubAnyAuditEvents([mcpRefusalEvent]);

    renderPage();
    await screen.findByText('mcp.tool_call.refused');

    fireEvent.change(screen.getByLabelText('Origin'), { target: { value: 'mcp' } });
    fireEvent.change(screen.getByLabelText('Refusal reason'), {
      target: { value: 'authz-denied' },
    });

    await waitFor(() => {
      expect(auditEventRequests(fetchMock)).toContain(
        '/api/v1/audit-events?skip=0&limit=25&origin=mcp&refusalReason=authz-denied&sort=createdAt&sortDir=desc',
      );
    });

    const chipRow = await screen.findByRole('list', { name: 'Applied filters' });
    expect(within(chipRow).getByText('Origin: MCP')).toBeInTheDocument();
    expect(within(chipRow).getByText('Refusal reason: authz-denied')).toBeInTheDocument();
  });

  it('applies a custom recorded date range as from/to query parameters, echoed as one chip', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');
    const requestsBeforeReveal = auditEventRequests(fetchMock).length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Recorded' }), {
      target: { value: 'custom' },
    });
    // An empty custom range filters nothing, so revealing it sends no request and shows no chip.
    expect(await screen.findByLabelText('From')).toHaveValue('');
    expect(auditEventRequests(fetchMock)).toHaveLength(requestsBeforeReveal);
    expect(screen.queryByRole('list', { name: 'Applied filters' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-05' } });

    await waitFor(() => {
      expect(
        auditEventRequests(fetchMock).some((url) => url.includes('from=') && url.includes('to=')),
      ).toBe(true);
    });

    const call = auditEventRequests(fetchMock).find(
      (url) => url.includes('from=') && url.includes('to='),
    );
    const requestUrl = new URL(call!, 'http://localhost');
    // Bounds are the operator's *local* midnight (`toDateRangeInstants`), not UTC — a hardcoded
    // `...T00:00:00.000Z` string would only match a UTC host and pass by accident there. Asserting
    // local date/time components instead catches a regression back to UTC arithmetic on any host.
    const fromDate = new Date(requestUrl.searchParams.get('from')!);
    expect([fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()]).toEqual([2026, 7, 1]);
    expect([fromDate.getHours(), fromDate.getMinutes()]).toEqual([0, 0]);

    // `to` is exclusive on the wire, so the picked end date is sent as local midnight the day after.
    const toDate = new Date(requestUrl.searchParams.get('to')!);
    expect([toDate.getFullYear(), toDate.getMonth(), toDate.getDate()]).toEqual([2026, 7, 6]);
    expect([toDate.getHours(), toDate.getMinutes()]).toEqual([0, 0]);

    const chipRow = await screen.findByRole('list', { name: 'Applied filters' });
    expect(within(chipRow).getByText('Recorded: 2026-08-01 → 2026-08-05')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(
      '?range=custom&from=2026-08-01&to=2026-08-05',
    );
  });

  it('applies Last 24 hours on selection as range=24h, sending a rolling 24-hour window, echoed as one chip', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByRole('combobox', { name: 'Recorded' }), {
      target: { value: '24h' },
    });

    await waitFor(() => {
      expect(auditEventRequests(fetchMock).some((url) => url.includes('from='))).toBe(true);
    });
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent('?range=24h');

    const call = auditEventRequests(fetchMock).find((url) => url.includes('from='));
    const requestUrl = new URL(call!, 'http://localhost');
    // A rolling window, not local midnight: the bounds are exactly 24 hours apart.
    const from = new Date(requestUrl.searchParams.get('from')!).getTime();
    const to = new Date(requestUrl.searchParams.get('to')!).getTime();
    expect(to - from).toBe(24 * 60 * 60 * 1000);

    const chipRow = await screen.findByRole('list', { name: 'Applied filters' });
    expect(within(chipRow).getByText('Recorded: Last 24 hours')).toBeInTheDocument();

    fireEvent.click(within(chipRow).getByRole('button', { name: 'Remove Recorded filter' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Recorded' })).toHaveValue('');
    });
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('renders the list for a malformed date in the URL, reading it as Any time', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage(['/audit-events?to=2026-13-01']);

    expect(await screen.findByText('document.deleted')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Recorded' })).toHaveValue('');
    expect(auditEventRequests(fetchMock)).toEqual([DEFAULT_URL]);
    expect(screen.queryByRole('list', { name: 'Applied filters' })).not.toBeInTheDocument();
  });

  it('requests the first page at the default size for an out-of-range limit and skip in the URL', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage(['/audit-events?limit=7&skip=-1']);

    expect(await screen.findByText('document.deleted')).toBeInTheDocument();
    expect(auditEventRequests(fetchMock)).toEqual([DEFAULT_URL]);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('applies the action 300 ms after typing stops, and at once on Enter', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');
    vi.useFakeTimers();
    const actionUrl = (action: string) =>
      `/api/v1/audit-events?skip=0&limit=25&action=${action}&sort=createdAt&sortDir=desc`;

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document' } });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document.deleted' } });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(auditEventRequests(fetchMock)).toEqual([DEFAULT_URL]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(auditEventRequests(fetchMock)).toEqual([DEFAULT_URL, actionUrl('document.deleted')]);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(auditEventRequests(fetchMock)).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'apiKey.revoked' } });
    fireEvent.keyDown(screen.getByLabelText('Action'), { key: 'Enter' });
    expect(auditEventRequests(fetchMock)).toEqual([
      DEFAULT_URL,
      actionUrl('document.deleted'),
      actionUrl('apiKey.revoked'),
    ]);
  });

  // The form holds two text-like fields (Action, Entity id), so a browser's own implicit
  // submission never fires — Enter applies only through the field's own keydown handler.
  it('applies exactly once on Enter in a form with two text filters', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document.deleted' } });
    fireEvent.keyDown(screen.getByLabelText('Action'), { key: 'Enter' });

    await waitFor(() => {
      expect(auditEventRequests(fetchMock)).toEqual([
        DEFAULT_URL,
        '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&sort=createdAt&sortDir=desc',
      ]);
    });
  });

  it("removes the action filter at once from the search field's clear control", async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage(['/audit-events?action=document.deleted']);
    await screen.findByText('document.deleted');
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(auditEventRequests(fetchMock).at(-1)).toBe(DEFAULT_URL);
    expect(screen.getByLabelText('Action')).toHaveValue('');
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('never applies an invalid entity id: its error shows on the field without moving focus, and a valid id then applies', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');
    vi.useFakeTimers();
    const input = screen.getByLabelText('Entity id');
    const origin = screen.getByLabelText('Origin');

    fireEvent.change(input, { target: { value: 'doc-1' } });
    origin.focus();
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const errorEl = screen.getByText(ENTITY_ID_ERROR, { exact: false, selector: 'p' });
    expect(errorEl).toHaveTextContent('Error:');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(errorEl.id);
    expect(origin).toHaveFocus();
    expect(auditEventRequests(fetchMock)).toEqual([DEFAULT_URL]);
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();

    fireEvent.change(input, { target: { value: VALID_ENTITY_ID } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(auditEventRequests(fetchMock)).toEqual([
      DEFAULT_URL,
      `/api/v1/audit-events?skip=0&limit=25&entityId=${VALID_ENTITY_ID}&sort=createdAt&sortDir=desc`,
    ]);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(ENTITY_ID_ERROR, { exact: false })).not.toBeInTheDocument();
    expect(origin).toHaveFocus();
  });

  it('applies a valid entity id at once on Enter', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText('Entity id'), { target: { value: VALID_ENTITY_ID } });
    fireEvent.keyDown(screen.getByLabelText('Entity id'), { key: 'Enter' });

    expect(auditEventRequests(fetchMock)).toEqual([
      DEFAULT_URL,
      `/api/v1/audit-events?skip=0&limit=25&entityId=${VALID_ENTITY_ID}&sort=createdAt&sortDir=desc`,
    ]);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(auditEventRequests(fetchMock)).toHaveLength(2);
  });

  it('drops the entity id error when its chip is removed', async () => {
    stubAnyAuditEvents([event]);

    renderPage([`/audit-events?entityId=${VALID_ENTITY_ID}`]);
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByLabelText('Entity id'), { target: { value: 'bad' } });
    expect(await screen.findByText(ENTITY_ID_ERROR, { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Entity id filter' }));

    await waitFor(() => {
      expect(screen.queryByText(ENTITY_ID_ERROR, { exact: false })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Entity id')).toHaveValue('');
    expect(screen.getByLabelText('Entity id')).not.toHaveAttribute('aria-invalid');
  });

  it('announces the result count once after a filter change, and nothing on first load', async () => {
    const listener = vi.fn<(message: string) => void>();
    subscribeAnnouncements(listener);
    stubAnyAuditEvents([mcpRefusalEvent]);

    renderPage();
    await screen.findByText('mcp.tool_call.refused');
    expect(listener).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Origin'), { target: { value: 'mcp' } });

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith('1 audit event');
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears the visible rows when a fetch for a new filter fails', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/audit-events?skip=0&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [event], count: 1 }));
      }
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ message: 'Audit log unavailable' }, 500));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document.deleted' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Audit log unavailable');
    expect(screen.queryByText('document.deleted')).not.toBeInTheDocument();
  });

  it('removing a chip clears just that filter, resets the page, and keeps the form in sync', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url ===
        '/api/v1/audit-events?skip=0&limit=25&action=document.deleted&origin=mcp&sort=createdAt&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [mcpRefusalEvent], count: 1 }));
      }
      if (url === '/api/v1/audit-events?skip=0&limit=25&origin=mcp&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [mcpRefusalEvent], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/audit-events?action=document.deleted&origin=mcp']);
    await screen.findByText('mcp.tool_call.refused');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Action filter' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url === '/api/v1/audit-events?skip=0&limit=25&origin=mcp&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });

    // The Action field itself cleared too, so no stale draft can re-apply the removed value.
    expect(screen.getByLabelText('Action')).toHaveValue('');
    expect(screen.getByRole('list', { name: 'Applied filters' })).toHaveTextContent('Origin: MCP');
    expect(screen.queryByText('Action: document.deleted')).not.toBeInTheDocument();
  });

  it('resets a mistyped entity id draft when a row filters to the subject already applied', async () => {
    stubAnyAuditEvents([event]);

    renderPage([`/audit-events?entityId=${event.subject.entityId}`]);
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByLabelText('Entity id'), { target: { value: 'bad' } });
    expect(await screen.findByText(ENTITY_ID_ERROR, { exact: false })).toBeInTheDocument();

    // The URL is unchanged — the shortcut re-selects the same entity id already applied — so the
    // draft has no applied change of its own to re-sync from.
    fireEvent.click(
      screen.getByRole('button', { name: `Filter to Document ${event.subject.entityId}` }),
    );

    expect(screen.getByLabelText('Entity id')).toHaveValue(event.subject.entityId);
    expect(screen.queryByText(ENTITY_ID_ERROR, { exact: false })).not.toBeInTheDocument();
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
    expect(screen.getByRole('list', { name: 'Applied filters' })).toHaveTextContent(
      'Entity id: doc-1',
    );
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
    await screen.findByText('26–30 of 30');

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'document.deleted' } });

    await screen.findByText('1–1 of 1');

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

    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('26–30 of 30');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/audit-events?skip=25&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('reveals an empty Custom range on page 2 without refetching, resetting skip, or announcing', async () => {
    const listener = vi.fn<(message: string) => void>();
    subscribeAnnouncements(listener);
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage(['/audit-events?skip=25']);
    await screen.findByText('document.deleted');
    const requestsBeforeReveal = auditEventRequests(fetchMock).length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Recorded' }), {
      target: { value: 'custom' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(auditEventRequests(fetchMock)).toHaveLength(requestsBeforeReveal);
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent(/skip=25/);
    expect(listener).not.toHaveBeenCalled();
  });

  it('blocks a From after To from reaching the API and keeps the last valid results', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage();
    await screen.findByText('document.deleted');

    fireEvent.change(screen.getByRole('combobox', { name: 'Recorded' }), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-20' } });
    await waitFor(() => {
      expect(
        auditEventRequests(fetchMock).some((url) => url.includes('from=') && !url.includes('to=')),
      ).toBe(true);
    });
    const requestsBeforeInvertedTo = auditEventRequests(fetchMock).length;

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-10' } });

    const toField = screen.getByLabelText('To');
    expect(toField).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('From must be on or before To.')).toBeInTheDocument();
    // No further request — not one carrying the inverted pair, not any other.
    expect(auditEventRequests(fetchMock)).toHaveLength(requestsBeforeInvertedTo);
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    const fetchMock = stubAnyAuditEvents([event]);

    renderPage(['/audit-events?sort=bogus&sortDir=up']);

    expect(await screen.findByText('document.deleted')).toBeInTheDocument();
    expect(auditEventRequests(fetchMock)).toEqual([DEFAULT_URL]);
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

    expect(await screen.findByText('Audit events')).toBeInTheDocument();
  });

  it('shows a member the 403 view for the route wrapped in RequireAdmin', async () => {
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

    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access to this page" }),
    ).toBeInTheDocument();
    expect(screen.queryByText('home probe')).not.toBeInTheDocument();
    expect(screen.queryByText('Audit events')).not.toBeInTheDocument();
  });
});
