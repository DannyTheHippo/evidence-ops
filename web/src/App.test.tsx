import { render, screen } from '@testing-library/react';
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
});
