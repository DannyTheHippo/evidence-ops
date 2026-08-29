import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../AuthenticatedRoutes';
import { clearSession } from '../lib/auth';
import PeoplePage from './PeoplePage';

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ME_URL = '/api/v1/auth/me';
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

// Dispatches by URL, matching SourcesPage.test.tsx's stubFetch shape. `session` defaults to
// signed-in-as-admin — every test fetches `/auth/me` for the "(you)" marker and the invite
// action, whether or not the test cares about either.
function stubFetch(
  routes: Record<string, RouteHandler> = {},
  session: RouteHandler = () => jsonResponse(admin),
): ReturnType<typeof vi.fn> {
  const defaults: Record<string, RouteHandler> = {
    [ME_URL]: session,
    [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [], count: 0 }),
    [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [], count: 0 }),
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

function switchToInvitations() {
  fireEvent.click(screen.getByRole('button', { name: 'Invitations' }));
}

describe('PeoplePage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists members sorted by email ascending by default, on the Members segment', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin, member], count: 2 }),
    });

    renderPage();

    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('member@example.com')).toBeInTheDocument();

    expect(
      screen.getByRole('region', { name: 'Members of this tenant and their roles' }),
    ).toHaveAttribute('tabindex', '0');
  });

  it('lists pending invitations with email, role, status and expiry, on the Invitations segment', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [pendingInvitation], count: 1 }),
    });

    renderPage();
    await screen.findByText('admin@example.com');
    switchToInvitations();

    expect(await screen.findByText('colleague@example.com')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();

    expect(
      screen.getByRole('region', { name: 'Invitations minted for this tenant' }),
    ).toHaveAttribute('tabindex', '0');
  });

  it('reads as empty when there are no members or invitations, on either segment', async () => {
    stubFetch();

    renderPage();

    expect(await screen.findByText('No members yet')).toBeInTheDocument();
    switchToInvitations();
    expect(await screen.findByText('No invitations yet')).toBeInTheDocument();
  });

  it('marks the signed-in operator\'s own row as "(you)"', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin, member], count: 2 }),
    });

    renderPage();
    await screen.findByText('admin@example.com');

    const adminRow = screen.getByText('admin@example.com').closest('tr');
    const memberRow = screen.getByText('member@example.com').closest('tr');
    expect(adminRow).toHaveTextContent('(you)');
    expect(memberRow).not.toHaveTextContent('(you)');
  });

  it('changes a member to admin via the kebab menu and updates the row in place', async () => {
    const fetchMock = stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [member], count: 1 }),
      '/api/v1/users/user-2/role': (init) =>
        init?.method === 'PATCH'
          ? jsonResponse({ ...member, role: 'admin' })
          : Promise.reject(new Error('unexpected method')),
    });

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for member@example.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make admin' }));
    const dialog = screen.getByRole('dialog', { name: 'Change "member@example.com" to admin?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Reopening the menu shows the action flipped to the opposite direction, proving the row
    // updated in place rather than only the server accepting the change.
    fireEvent.click(screen.getByRole('button', { name: 'Actions for member@example.com' }));
    expect(screen.getByRole('menuitem', { name: 'Make member' })).toBeInTheDocument();

    const roleCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/v1/users/user-2/role' && (init as RequestInit)?.method === 'PATCH',
    );
    expect(JSON.parse((roleCall?.[1] as RequestInit).body as string)).toEqual({ role: 'admin' });
  });

  it('surfaces a legible reason when demoting the last admin is refused, guessing nothing client-side', async () => {
    const refusalMessage =
      "Tenant 'tenant-a' must always keep at least one admin; changing user 'user-1' to 'member' would leave none";
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      '/api/v1/users/user-1/role': () => jsonResponse({ message: refusalMessage }, 409),
    });

    renderPage();
    await screen.findByText('admin@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for admin@example.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make member' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Change "admin@example.com" to member?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make member' }));

    // Nothing here refuses the action before the request goes out — the client never guesses at
    // the last-admin rule, it only renders whatever the server's 409 says.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusalMessage);
    expect(
      within(dialog).getByRole('heading', { name: 'Change "admin@example.com" to member?' }),
    ).toBeInTheDocument();
  });

  it('revoking sessions states plainly that every device is signed out and every API key stops working', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [member], count: 1 }),
    });

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for member@example.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke sessions' }));

    const dialog = screen.getByRole('dialog', {
      name: 'Revoke sessions for "member@example.com"?',
    });
    expect(within(dialog).getByText(/browser session/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/API key/i)).toBeInTheDocument();
  });

  it('confirming a session revocation calls the API and closes the dialog', async () => {
    const fetchMock = stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [member], count: 1 }),
      '/api/v1/users/user-2/revoke-sessions': (init) =>
        init?.method === 'POST'
          ? jsonResponse(member)
          : Promise.reject(new Error('unexpected method')),
    });

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for member@example.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke sessions' }));
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
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [member], count: 1 }),
      '/api/v1/users/user-2': (init) =>
        init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Promise.reject(new Error('unexpected method')),
    });

    renderPage();
    await screen.findByText('member@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for member@example.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove member' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));

    await waitFor(() => {
      expect(screen.queryByText('member@example.com')).not.toBeInTheDocument();
    });
  });

  it('sorts members by a column, writing the new sort into the URL', async () => {
    const fetchMock = stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      '/api/v1/users?skip=0&limit=25&sort=role&sortDir=desc': () =>
        jsonResponse({ docs: [admin], count: 1 }),
    });

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

  it('keeps the address bar clean at the default view, sort and page', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
    });

    renderPage();

    await screen.findByText('admin@example.com');
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('reproduces a sorted, paged member view from a deep link', async () => {
    stubFetch({
      '/api/v1/users?skip=25&limit=25&sort=role&sortDir=desc': () =>
        jsonResponse({ docs: [member], count: 30 }),
    });

    renderPage(['/people?sort=role&sortDir=desc&skip=25']);

    await screen.findByText('member@example.com');
  });

  it('reproduces the Invitations segment, paged, from a deep link', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      '/api/v1/invitations?skip=25&limit=25': () =>
        jsonResponse({ docs: [pendingInvitation], count: 30 }),
    });

    renderPage(['/people?view=invitations&invSkip=25']);

    expect(
      await screen.findByRole('region', { name: 'Invitations minted for this tenant' }),
    ).toBeInTheDocument();
    expect(screen.getByText('colleague@example.com')).toBeInTheDocument();
  });

  it('shows a fragment-carried invite link exactly once at mint, switching to the Invitations segment', async () => {
    const fetchMock = stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      '/api/v1/invitations': (init) =>
        init?.method === 'POST'
          ? jsonResponse(mintedInvitation, 201)
          : Promise.reject(new Error('unexpected method')),
    });

    renderPage();
    await screen.findByText('admin@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite member' });
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'new-hire@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));

    const expectedLink = `${window.location.origin}/invite#token=${mintedInvitation.token}`;
    expect(await screen.findByText(expectedLink)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Email invite' })).toHaveAttribute(
      'href',
      expect.stringContaining(`mailto:${mintedInvitation.email}`),
    );
    // The mint switches the page onto the Invitations segment and moves focus onto the panel
    // holding the one copy of the link that will ever exist — deferred a frame, so this settles
    // rather than asserting synchronously.
    expect(screen.getByRole('button', { name: 'Invitations' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => {
      expect(document.activeElement).toHaveClass('secret-reveal');
    });

    const mintCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/invitations' && (init as RequestInit)?.method === 'POST',
    );
    expect(JSON.parse((mintCall?.[1] as RequestInit).body as string)).toEqual({
      email: 'new-hire@example.com',
      role: 'member',
    });
  });

  it('invites a colleague as admin when Admin is selected', async () => {
    const fetchMock = stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      '/api/v1/invitations': (init) =>
        init?.method === 'POST'
          ? jsonResponse({ ...mintedInvitation, role: 'admin' }, 201)
          : Promise.reject(new Error('unexpected method')),
    });

    renderPage();
    await screen.findByText('admin@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite member' });
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'new-hire@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Admin/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));

    await waitFor(() => {
      const mintCall = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/v1/invitations' && (init as RequestInit)?.method === 'POST',
      );
      expect(mintCall).toBeDefined();
      expect(JSON.parse((mintCall?.[1] as RequestInit).body as string)).toEqual({
        email: 'new-hire@example.com',
        role: 'admin',
      });
    });
  });

  it('refuses to submit the invite form without a plausible email shape', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
    });

    renderPage();
    await screen.findByText('admin@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite member' });
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));

    expect(await within(dialog).findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('states before resending that the previous link stops working, not only after', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [pendingInvitation], count: 1 }),
    });

    renderPage();
    await screen.findByText('admin@example.com');
    switchToInvitations();
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
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [pendingInvitation], count: 1 }),
      '/api/v1/invitations/invitation-1/resend': (init) =>
        init?.method === 'POST'
          ? jsonResponse(resent)
          : Promise.reject(new Error('unexpected method')),
    });

    renderPage();
    await screen.findByText('admin@example.com');
    switchToInvitations();
    await screen.findByText('colleague@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));

    const expectedLink = `${window.location.origin}/invite#token=${resent.token}`;
    expect(await screen.findByText(expectedLink)).toBeInTheDocument();
    expect(screen.getByText(/previous link has already stopped working/i)).toBeInTheDocument();
  });

  it('revoking an invitation marks it revoked and hides its actions', async () => {
    stubFetch({
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
      [DEFAULT_INVITATIONS_URL]: () => jsonResponse({ docs: [pendingInvitation], count: 1 }),
      '/api/v1/invitations/invitation-1': (init) =>
        init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Promise.reject(new Error('unexpected method')),
    });

    renderPage();
    await screen.findByText('admin@example.com');
    switchToInvitations();
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
      [DEFAULT_MEMBERS_URL]: () => jsonResponse({ docs: [admin], count: 1 }),
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
    stubFetch({}, () => jsonResponse(member));

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
