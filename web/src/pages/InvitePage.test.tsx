import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InvitePage from './InvitePage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PREVIEW_URL = '/api/v1/invitations/preview';

function previewResponse(overrides: Partial<{ invitedBy: string | undefined }> = {}): Response {
  return jsonResponse({
    email: 'invitee@example.com',
    role: 'member',
    invitedBy: 'invitedBy' in overrides ? overrides.invitedBy : 'admin@example.com',
  });
}

function renderPage(path = '/invite#token=eo_inv_fixture-token') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <InvitePage />
    </MemoryRouter>,
  );
}

function submit(password: string): void {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
}

describe('InvitePage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows a page-level error and no form when the link carries no token, with a way back to sign-in', () => {
    renderPage('/invite');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This invitation link is missing its token.',
    );
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('renders a password field, its length rule, and a submit control when a token is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(previewResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText('8-72 characters', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(PREVIEW_URL, expect.anything()));
  });

  // A token in the query string reaches the server on every request and is written to the access
  // log — this asserts the page reads only the fragment, so a link built the old way (or a query
  // string an attacker appends) never yields a working form.
  it('treats a token carried in the query string as missing, since only the fragment is trusted', () => {
    renderPage('/invite?token=eo_inv_fixture-token');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This invitation link is missing its token.',
    );
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('previews who invited the visitor and to what role before the form is used', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          email: 'invitee@example.com',
          role: 'admin',
          invitedBy: 'founder@example.com',
        }),
      ),
    );

    renderPage();

    expect(
      await screen.findByText('founder@example.com invited you to join as admin.', {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it('names the role without an inviter identity when the invitation carries none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(previewResponse({ invitedBy: undefined })));

    renderPage();

    expect(
      await screen.findByText("You've been invited to join as member.", { exact: false }),
    ).toBeInTheDocument();
  });

  it('falls back to the same recovery path as a rejected redemption when the preview itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'Invitation is invalid, expired, or already used' }, 400),
        ),
    );

    renderPage();

    expect(await screen.findByRole('link', { name: 'sign in' }, { timeout: 3000 })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('redeems the token with only a password, then logs in with the returned email', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === PREVIEW_URL) {
        return Promise.resolve(previewResponse());
      }
      if (url === '/api/v1/auth/register' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              id: 'user-1',
              email: 'invitee@example.com',
              role: 'member',
              createdAt: '2026-08-01T00:00:00.000Z',
            },
            201,
          ),
        );
      }
      if (url === '/api/v1/auth/login' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            user: {
              id: 'user-1',
              email: 'invitee@example.com',
              role: 'member',
              createdAt: '2026-08-01T00:00:00.000Z',
            },
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(PREVIEW_URL, expect.anything()));
    submit('correct-horse-battery');

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/auth/login')).toBe(true);
    });

    const registerCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/auth/register');
    expect(JSON.parse((registerCall?.[1] as RequestInit).body as string)).toEqual({
      password: 'correct-horse-battery',
      invitationToken: 'eo_inv_fixture-token',
    });

    const loginCall = fetchMock.mock.calls.find(([url]) => url === '/api/v1/auth/login');
    expect(JSON.parse((loginCall?.[1] as RequestInit).body as string)).toEqual({
      email: 'invitee@example.com',
      password: 'correct-horse-battery',
    });
  });

  it('shows the server-authored reason for a rejected redemption, verbatim, and replaces the form with a recovery path', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === PREVIEW_URL) {
        return Promise.resolve(previewResponse());
      }
      return Promise.resolve(
        jsonResponse({ message: 'Invitation is invalid, expired, or already used' }, 400),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(PREVIEW_URL, expect.anything()));
    submit('correct-horse-battery');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invitation is invalid, expired, or already used',
    );
    // A rejected redemption is not something resubmitting the same form can fix, so the form is
    // gone and only the two paths that can help remain: a fresh link, or signing in.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/login');
  });

  it('falls back to a connection message instead of a raw browser exception', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === PREVIEW_URL) {
        return Promise.resolve(previewResponse());
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(PREVIEW_URL, expect.anything()));
    submit('correct-horse-battery');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('focuses the password field when an empty form is submitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(previewResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(PREVIEW_URL, expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveFocus());
  });

  it('shows no stray alert when a preview failure alone triggers the recovery path', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'Invitation is invalid, expired, or already used' }, 400),
        ),
    );

    renderPage();

    await screen.findByRole('link', { name: 'sign in' });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
