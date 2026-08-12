import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as auth from './lib/auth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('App / RequireAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders neither the protected content nor a redirect while the session probe is pending', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Evidence Ops' })).not.toBeInTheDocument();
  });

  it('renders the protected content once the probe resolves a user', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 })));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('redirects to /login when the probe resolves anon', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Evidence Ops' })).toBeInTheDocument();
  });

  it('redirects to /login when the probe rejects', async () => {
    vi.spyOn(auth, 'ensureSession').mockRejectedValue(new Error('network error'));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Evidence Ops' })).toBeInTheDocument();
  });

  // Regression: logout() used to await the POST and only then clear the local session and
  // navigate, so a rejected request (e.g. a CSRF 403) left the user looking logged in with a
  // button that appeared to do nothing. The local clear and the navigation must both happen
  // regardless of the server's answer.
  it('clears the local session and navigates to /login even when the logout request fails', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    const clearSessionSpy = vi.spyOn(auth, 'clearSession');
    const fetchMock = vi.fn((url: string) =>
      url === '/api/v1/auth/logout'
        ? Promise.resolve(jsonResponse({ message: 'Forbidden' }, 403))
        : Promise.resolve(
            jsonResponse({
              id: 'user-1',
              email: 'user@example.com',
              role: 'member',
              createdAt: new Date().toISOString(),
            }),
          ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Logout' }));

    expect(await screen.findByRole('heading', { name: 'Evidence Ops' })).toBeInTheDocument();
    expect(clearSessionSpy).toHaveBeenCalled();
  });
});
