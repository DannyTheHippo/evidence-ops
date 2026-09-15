import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function stubFetch(me: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/v1/auth/me') return Promise.resolve(me());
    return Promise.reject(new Error(`Unhandled fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invitations" element={<InvitationsPage />} />
        <Route path="/people" element={<p>people probe</p>} />
        <Route path="/login" element={<p>login probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvitationsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('redirects a signed-in visitor to /people, keeping an existing link or bookmark working', async () => {
    stubFetch(() => jsonResponse(admin));

    renderAt('/invitations');

    expect(await screen.findByText('people probe')).toBeInTheDocument();
  });

  it('sends an anonymous visitor to sign in, not to a guarded page', async () => {
    stubFetch(() => jsonResponse(null, 401));

    renderAt('/invitations');

    expect(await screen.findByText('login probe')).toBeInTheDocument();
  });
});
