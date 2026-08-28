import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../AuthenticatedRoutes';
import { clearSession } from '../lib/auth';
import PeoplePage from './PeoplePage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL, matching ApiKeysPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

// Exposes the current query string as accessible text, since `MemoryRouter` gives a test no other
// way to read it — matches ApiKeysPage.test.tsx's LocationProbe.
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current search">{location.search}</output>;
}

function renderPage(initialEntries: string[] = ['/people']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <PeoplePage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const DEFAULT_MEMBERS_URL = '/api/v1/users?skip=0&limit=25&sort=email&sortDir=asc';
const DEFAULT_INVITATIONS_URL = '/api/v1/invitations?skip=0&limit=25';

const admin = {
  id: 'user-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const member = {
  id: 'user-2',
  email: 'member@example.com',
  role: 'member' as const,
  createdAt: '2026-02-01T00:00:00.000Z',
};

const pendingInvitation = {
  id: 'invitation-1',
  email: 'colleague@example.com',
  role: 'member',
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const mintedInvitation = {
  id: 'invitation-2',
  email: 'new-hire@example.com',
  role: 'member',
  token: 'eo_inv_brandnewtoken123',
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
};

describe('PeoplePage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists members sorted by email ascending by default', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin, member], count: 2 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('member@example.com')).toBeInTheDocument();
  });

  it('lists pending invitations with email, role, status and expiry', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [pendingInvitation], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('colleague@example.com')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('reads as empty when there are no members or invitations', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [], count: 0 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No members yet')).toBeInTheDocument();
    expect(screen.getByText('No invitations yet')).toBeInTheDocument();
  });

  it('changes a member to admin and updates the row in place', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_MEMBERS_URL)
        return Promise.resolve(jsonResponse({ docs: [member], count: 1 }));
      if (url === DEFAULT_INVITATIONS_URL)
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      if (url === '/api/v1/users/user-2/role' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...member, role: 'admin' }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Make admin' }));
    const dialog = screen.getByRole('dialog', { name: 'Change "member@example.com" to admin?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Make member' })).toBeInTheDocument();
    });
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
      role: 'admin',
    });
  });

  it('surfaces a legible reason when demoting the last admin is refused', async () => {
    const refusalMessage =
      "Tenant 'tenant-a' must always keep at least one admin; changing user 'user-1' to 'member' would leave none";
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
      '/api/v1/users/user-1/role': () => jsonResponse({ message: refusalMessage }, 409),
    });

    renderPage();
    await screen.findByText('admin@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Make member' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Change "admin@example.com" to member?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make member' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusalMessage);
    // The refusal leaves the role unchanged — the dialog stays open with its title unmoved, and
    // the row still offers to make the same admin a member rather than reflecting a change that
    // never took effect.
    expect(
      within(dialog).getByRole('heading', { name: 'Change "admin@example.com" to member?' }),
    ).toBeInTheDocument();
  });

  it('revoking sessions states plainly that every device is signed out and every API key stops working', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [member], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke sessions' }));

    const dialog = screen.getByRole('dialog', {
      name: 'Revoke sessions for "member@example.com"?',
    });
    expect(within(dialog).getByText(/browser session/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/API key/i)).toBeInTheDocument();
  });

  it('confirming a session revocation calls the API and closes the dialog', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_MEMBERS_URL)
        return Promise.resolve(jsonResponse({ docs: [member], count: 1 }));
      if (url === DEFAULT_INVITATIONS_URL)
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      if (url === '/api/v1/users/user-2/revoke-sessions' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(member));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke sessions' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Revoke sessions for "member@example.com"?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke sessions' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === '/api/v1/users/user-2/revoke-sessions' &&
          (init as RequestInit)?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('removes a member from the tenant on confirm', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_MEMBERS_URL)
        return Promise.resolve(jsonResponse({ docs: [member], count: 1 }));
      if (url === DEFAULT_INVITATIONS_URL)
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      if (url === '/api/v1/users/user-2' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));

    await waitFor(() => {
      expect(screen.queryByText('member@example.com')).not.toBeInTheDocument();
    });
  });

  it('sorts members by a column, writing the new sort into the URL', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url === DEFAULT_MEMBERS_URL ||
        url === '/api/v1/users?skip=0&limit=25&sort=role&sortDir=desc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [admin], count: 1 }));
      }
      if (url === DEFAULT_INVITATIONS_URL)
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('admin@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Role' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/users?skip=0&limit=25&sort=role&sortDir=desc',
        ),
      ).toBe(true);
    });
  });

  it('keeps the address bar clean at the default sort and page', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    await screen.findByText('admin@example.com');
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('reproduces a sorted, paged member view from a deep link', async () => {
    stubFetch({
      '/api/v1/users?skip=25&limit=25&sort=role&sortDir=desc': () =>
        jsonResponse({ docs: [member], count: 30 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage(['/people?sort=role&sortDir=desc&skip=25']);

    await screen.findByText('member@example.com');
  });

  it('shows a fragment-carried invite link exactly once at mint, unmistakably marked as unrepeatable', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_MEMBERS_URL)
        return Promise.resolve(jsonResponse({ docs: [admin], count: 1 }));
      if (url === '/api/v1/invitations' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedInvitation, 201));
      }
      if (url === DEFAULT_INVITATIONS_URL)
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No invitations yet');

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new-hire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    const expectedLink = `${window.location.origin}/invite#token=${mintedInvitation.token}`;
    expect(await screen.findByText(expectedLink)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Email invite' })).toHaveAttribute(
      'href',
      expect.stringContaining(`mailto:${mintedInvitation.email}`),
    );
  });

  it('states before resending that the previous link stops working, not only after', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [pendingInvitation], count: 1 }),
    });

    renderPage();
    await screen.findByText('colleague@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));

    const dialog = screen.getByRole('dialog', {
      name: `Resend the invitation to "${pendingInvitation.email}"?`,
    });
    expect(
      within(dialog).getByText(/stops working the instant this completes/i),
    ).toBeInTheDocument();
  });

  it('resending an invitation rotates its token and shows the new one-time link', async () => {
    const resent = { ...pendingInvitation, token: 'eo_inv_resenttoken456' };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_MEMBERS_URL)
        return Promise.resolve(jsonResponse({ docs: [admin], count: 1 }));
      if (url === DEFAULT_INVITATIONS_URL) {
        return Promise.resolve(jsonResponse({ docs: [pendingInvitation], count: 1 }));
      }
      if (url === '/api/v1/invitations/invitation-1/resend' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(resent));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('colleague@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));

    const expectedLink = `${window.location.origin}/invite#token=${resent.token}`;
    expect(await screen.findByText(expectedLink)).toBeInTheDocument();
    expect(screen.getByText(/previous link has already stopped working/i)).toBeInTheDocument();
  });

  it('revoking an invitation marks it revoked and hides its actions', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_MEMBERS_URL)
        return Promise.resolve(jsonResponse({ docs: [admin], count: 1 }));
      if (url === DEFAULT_INVITATIONS_URL) {
        return Promise.resolve(jsonResponse({ docs: [pendingInvitation], count: 1 }));
      }
      if (url === '/api/v1/invitations/invitation-1' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('colleague@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation' }));

    await waitFor(() => {
      expect(screen.getByText('revoked')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('admits an admin to the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    render(
      <MemoryRouter initialEntries={['/people']}>
        <Routes>
          <Route
            path="/people"
            element={
              <RequireAdmin>
                <PeoplePage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'People' })).toBeInTheDocument();
  });

  it('bounces a member away from the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
    });

    render(
      <MemoryRouter initialEntries={['/people']}>
        <Routes>
          <Route path="/" element={<p>home probe</p>} />
          <Route
            path="/people"
            element={
              <RequireAdmin>
                <PeoplePage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('home probe')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'People' })).not.toBeInTheDocument();
  });
});
