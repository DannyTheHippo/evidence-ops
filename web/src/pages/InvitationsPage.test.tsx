import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../AuthenticatedRoutes';
import { clearSession } from '../lib/auth';
import InvitationsPage from './InvitationsPage';

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

// Dispatches by URL and method, matching ApiKeysPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('InvitationsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists pending invitations with email, role, status and expiry', async () => {
    stubFetch({
      '/api/v1/invitations?skip=0&limit=25': () =>
        jsonResponse({ docs: [pendingInvitation], count: 1 }),
    });

    render(<InvitationsPage />);

    expect(await screen.findByText('colleague@example.com')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('reads as empty when there are no invitations', async () => {
    stubFetch({
      '/api/v1/invitations?skip=0&limit=25': () => jsonResponse({ docs: [], count: 0 }),
    });

    render(<InvitationsPage />);

    expect(await screen.findByText('No invitations yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error when the invitation list fails to load', async () => {
    stubFetch({
      '/api/v1/invitations?skip=0&limit=25': () =>
        jsonResponse({ message: 'Invitations unavailable' }, 500),
    });

    render(<InvitationsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Invitations unavailable');
  });

  it('shows a fragment-carried invite link exactly once at mint, unmistakably marked as unrepeatable', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/invitations' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedInvitation, 201));
      }
      if (url === '/api/v1/invitations?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InvitationsPage />);
    await screen.findByText('No invitations yet');

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new-hire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    // The token rides the fragment, not the query string — a fragment is never sent to the server,
    // so it cannot end up in an access log.
    const expectedLink = `${window.location.origin}/invite#token=${mintedInvitation.token}`;
    expect(await screen.findByText(expectedLink)).toBeInTheDocument();

    // The list row for the newly minted invitation never repeats the token — the one-time panel
    // is the only place it appears.
    const listRows = screen.getAllByRole('row');
    for (const row of listRows) {
      expect(row).not.toHaveTextContent(mintedInvitation.token);
    }

    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      email: 'new-hire@example.com',
      role: 'member',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(expectedLink)).not.toBeInTheDocument();
    expect(screen.getByText('new-hire@example.com')).toBeInTheDocument();
  });

  it('copies the fragment-carried invite link, not a bare token, to the clipboard', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/invitations' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedInvitation, 201));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<InvitationsPage />);
    await screen.findByText('No invitations yet');

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new-hire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/invite#token=${mintedInvitation.token}`,
      );
    });
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('shows the mint error and leaves any previous token panel cleared', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/invitations' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'Email already has an account' }, 409));
      }
      if (url === '/api/v1/invitations?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InvitationsPage />);
    await screen.findByText('No invitations yet');

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'existing@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email already has an account');
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/invitations?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [pendingInvitation], count: 30 }));
      }
      if (url === '/api/v1/invitations?skip=25&limit=25') {
        return Promise.resolve(
          jsonResponse({ docs: [{ ...pendingInvitation, id: 'invitation-3' }], count: 30 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InvitationsPage />);
    await screen.findByText('colleague@example.com');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('30 total');
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/v1/invitations?skip=25&limit=25'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('admits an admin to the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/invitations?skip=0&limit=25': () =>
        jsonResponse({ docs: [pendingInvitation], count: 1 }),
    });

    render(
      <MemoryRouter initialEntries={['/invitations']}>
        <Routes>
          <Route
            path="/invitations"
            element={
              <RequireAdmin>
                <InvitationsPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Invitations' })).toBeInTheDocument();
  });

  it('bounces a member away from the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
    });

    render(
      <MemoryRouter initialEntries={['/invitations']}>
        <Routes>
          <Route path="/" element={<p>home probe</p>} />
          <Route
            path="/invitations"
            element={
              <RequireAdmin>
                <InvitationsPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('home probe')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Invitations' })).not.toBeInTheDocument();
  });
});
