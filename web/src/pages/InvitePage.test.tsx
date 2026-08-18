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

function renderPage(path = '/invite?token=eo_inv_fixture-token') {
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

  it('shows a page-level error and no form when the link carries no token', () => {
    renderPage('/invite');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This invitation link is missing its token.',
    );
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('renders a password field and submit control when a token is present', () => {
    renderPage();

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();
  });

  it('redeems the token with only a password, then logs in with the returned email', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
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

  it('shows the server-authored reason for a rejected redemption, verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'Invitation is invalid, expired, or already used' }, 400),
        ),
    );

    renderPage();
    submit('correct-horse-battery');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invitation is invalid, expired, or already used',
    );
  });

  it('falls back to a connection message instead of a raw browser exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    renderPage();
    submit('correct-horse-battery');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Check your connection and try again.',
    );
  });
});
