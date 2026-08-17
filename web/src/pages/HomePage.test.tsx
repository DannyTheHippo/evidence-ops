import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from './HomePage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const me = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'member',
  createdAt: '2026-01-15T09:30:00.000Z',
};

function stubFetch(routes: Record<string, () => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    }),
  );
}

function renderPage() {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the signed-in account details once the profile loads', async () => {
    stubFetch({ '/api/v1/auth/me': () => jsonResponse(me) });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(await screen.findByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText(new Date(me.createdAt).toLocaleDateString())).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // A rejected /auth/me is exempt from the client's 401-redirect rule, so the failure has to show
  // up on this page rather than bouncing the user to /login.
  it('shows an error instead of the account details when the profile request fails', async () => {
    stubFetch({ '/api/v1/auth/me': () => jsonResponse({ message: 'Unauthorized' }, 401) });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByText('user@example.com')).not.toBeInTheDocument();
  });
});
