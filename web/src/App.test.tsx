import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { RequireAdmin } from './App';
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

    // Logout lives inside the topbar's account menu, so the menu has to be open before the item
    // exists in the tree at all.
    fireEvent.click(await screen.findByRole('button', { name: 'user@example.com' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));

    expect(await screen.findByRole('heading', { name: 'Evidence Ops' })).toBeInTheDocument();
    expect(clearSessionSpy).toHaveBeenCalled();
  });
});

function renderAtHome() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
}

describe('App / admin-only nav link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // HomePage's getMe() fires as soon as RequireAuth resolves; an unstubbed fetch would hit the
  // relative URL for real and land in HomePage's error branch.
  function stubMeFetch(role: 'admin' | 'member') {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            id: 'user-1',
            email: `${role}@example.com`,
            role,
            createdAt: new Date().toISOString(),
          }),
        ),
      ),
    );
  }

  it('shows the Audit Log link to an admin', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'admin@example.com',
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
    stubMeFetch('admin');

    renderAtHome();

    expect(await screen.findByRole('link', { name: 'Audit Log' })).toBeInTheDocument();
  });

  it('hides the Audit Log link from a member', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-2',
      email: 'member@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    stubMeFetch('member');

    renderAtHome();

    // The protected page rendering is what proves the probe resolved, so the absence below is the
    // role gate holding rather than the session still being in flight.
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
  });

  it('renders no Audit Log link while the session probe is still pending', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));

    renderAtHome();

    // The chrome is route-based, so the rest of the nav is already on screen — the link is absent
    // because the role is unknown, not because the header has yet to render.
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
  });
});

function renderRequireAdmin() {
  render(
    <MemoryRouter initialEntries={['/admin-only']}>
      <Routes>
        <Route
          path="/admin-only"
          element={
            <RequireAdmin>
              <p>admin content</p>
            </RequireAdmin>
          }
        />
        <Route path="/" element={<p>home probe</p>} />
        <Route path="/login" element={<p>login probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAdmin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('an admin sees the wrapped content', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'admin@example.com',
      role: 'admin',
      createdAt: new Date().toISOString(),
    });

    renderRequireAdmin();

    expect(await screen.findByText('admin content')).toBeInTheDocument();
  });

  it('a member is redirected to / rather than seeing the wrapped content', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-2',
      email: 'member@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });

    renderRequireAdmin();

    expect(await screen.findByText('home probe')).toBeInTheDocument();
    expect(screen.queryByText('admin content')).not.toBeInTheDocument();
  });

  it('an anonymous visitor is redirected to /login', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);

    renderRequireAdmin();

    expect(await screen.findByText('login probe')).toBeInTheDocument();
    expect(screen.queryByText('admin content')).not.toBeInTheDocument();
  });

  it('renders nothing while the session probe is pending', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));

    renderRequireAdmin();

    expect(screen.queryByText('admin content')).not.toBeInTheDocument();
    expect(screen.queryByText('home probe')).not.toBeInTheDocument();
    expect(screen.queryByText('login probe')).not.toBeInTheDocument();
  });
});

describe('App / shell', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the skip link as the first link, pointing at the focusable main region', async () => {
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
    await screen.findByRole('heading', { name: 'Home' });

    const [firstLink] = screen.getAllByRole('link');
    expect(firstLink).toHaveTextContent('Skip to content');
    expect(firstLink).toHaveAttribute('href', '#main-content');

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('hides the sidebar and topbar chrome on /login', () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    // The account menu trigger, not a Logout button — Logout moved inside the menu, so querying
    // for it here would pass whether or not the chrome rendered.
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Evidence Ops' })).toBeInTheDocument();
  });

  it('hides the sidebar and topbar chrome on /invite', () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={['/invite#token=eo_inv_fixture']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Join your team' })).toBeInTheDocument();
  });

  it('renders a 404 view with a way back home for an unmatched authenticated route', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });

    render(
      <MemoryRouter initialEntries={['/nothing-here']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/');
  });

  // Regression: AnswersPage links each row to /answers/:id, but no such route existed — every
  // link landed on the 404 view instead of the answer it named.
  it('renders the answer detail page, not the 404 view, at /answers/:id', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'answer-1',
          questionText: 'What is the cap rate?',
          runStatus: 'completed',
          outcome: { kind: 'insufficient_evidence', reason: 'No document mentions the cap rate.' },
          citations: [],
          conflictIds: [],
          createdAt: new Date().toISOString(),
        }),
      ),
    );

    render(
      <MemoryRouter initialEntries={['/answers/answer-1']}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: 'What is the cap rate?' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
  });
});
