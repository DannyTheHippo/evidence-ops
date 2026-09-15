import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { clearToasts, getToasts, notify } from './components/ui/toast';
import * as auth from './lib/auth';
import { subscribeAnnouncements, unsubscribeAnnouncements } from './lib/announce';

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
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('redirects to /login when the probe rejects', async () => {
    vi.spyOn(auth, 'ensureSession').mockRejectedValue(new Error('network error'));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: 'user@example.com, Member' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
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

  it('shows the Audit events link to an admin', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'admin@example.com',
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
    stubMeFetch('admin');

    renderAtHome();

    expect(await screen.findByRole('link', { name: 'Audit events' })).toBeInTheDocument();
  });

  it('hides the Audit events link from a member', async () => {
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
    expect(screen.queryByRole('link', { name: 'Audit events' })).not.toBeInTheDocument();
  });

  it('renders no chrome while the session probe is pending, then the sidebar once authed', async () => {
    let resolveProbe: (me: {
      id: string;
      email: string;
      role: 'member';
      createdAt: string;
    }) => void = () => {};
    vi.spyOn(auth, 'ensureSession').mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    stubMeFetch('member');

    renderAtHome();

    // The shell is gated on an authed session, not just the route — a pending probe shows the
    // loading skeleton instead of chrome with a role-unknown nav.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();

    resolveProbe({
      id: 'user-2',
      email: 'member@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });

    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit events' })).not.toBeInTheDocument();
  });
});

describe('App / shell', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    clearToasts();
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
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
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
    // Dispatched by URL rather than answering everything alike: a completed answer also drives the
    // batch version lookup, which reads a `{ docs, count }` envelope off its response, and its own
    // `AttestationBundleView`, which fetches `/attestation` once `runStatus` is `completed`.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/v1/documents/versions/lookup')) {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        if (url === '/api/v1/answers/answer-1/attestation') {
          return Promise.resolve(
            jsonResponse({
              schemaVersion: 1,
              kind: 'answer',
              subjectId: 'answer-1',
              tenantId: 't',
              producedAt: new Date().toISOString(),
              subject: { question: 'What is the cap rate?' },
              outcome: 'insufficient_evidence',
              claims: [],
              decisions: [],
              measures: [],
              integrity: { algorithm: 'sha256', contentHash: 'abc' },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            id: 'answer-1',
            questionText: 'What is the cap rate?',
            runStatus: 'completed',
            outcome: {
              kind: 'insufficient_evidence',
              reason: 'No document mentions the cap rate.',
            },
            citations: [],
            conflictIds: [],
            createdAt: new Date().toISOString(),
          }),
        );
      }),
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

  // Regression: /answers/:id and /answers/verifications/:id share the /answers prefix — a route
  // table that ranked them wrong would render the answer detail page with id === 'verifications'
  // instead of the verification detail page.
  it('renders the verification detail page, not the answer detail view, at /answers/verifications/:id', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/v1/documents/versions/lookup')) {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        if (url === '/api/v1/verifications/ver-1/attestation') {
          return Promise.resolve(
            jsonResponse({
              schemaVersion: 1,
              kind: 'verification',
              subjectId: 'ver-1',
              tenantId: 't',
              producedAt: new Date().toISOString(),
              subject: { claims: ['The cap rate is approximately 6.10%.'] },
              outcome: null,
              claims: [],
              decisions: [],
              measures: [],
              integrity: { algorithm: 'sha256', contentHash: 'abc' },
            }),
          );
        }
        if (url === '/api/v1/verifications/ver-1') {
          return Promise.resolve(
            jsonResponse({
              id: 'ver-1',
              requestedBy: { kind: 'pat', id: 'pat-1' },
              claims: ['The cap rate is approximately 6.10%.'],
              results: [{ claimIndex: 0, verdict: 'grounded', citations: [] }],
              advisory:
                'This check does not certify the source values are correct, only that they are cited.',
              retrievedChunkIds: [],
              atoms: [],
              usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.0025 },
              createdAt: new Date().toISOString(),
            }),
          );
        }
        return Promise.resolve(jsonResponse({}, 404));
      }),
    );

    render(
      <MemoryRouter initialEntries={['/answers/verifications/ver-1']}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: 'The cap rate is approximately 6.10%.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
  });

  it('moves focus to the page h1 on navigation, resets scrollTop and announces the title', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 })));
    const messages: string[] = [];
    const listener = (message: string) => messages.push(message);
    subscribeAnnouncements(listener);

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Home' });

    const main = screen.getByRole('main');
    main.scrollTop = 200;
    expect(main.scrollTop).toBe(200);

    fireEvent.click(screen.getByRole('link', { name: 'Sources' }));

    const heading = await screen.findByRole('heading', { name: 'Sources', level: 1 });
    expect(main.scrollTop).toBe(0);
    expect(messages).toContain('Sources');
    // PageHeader's <h1> carries tabIndex={-1}, asserted last so the two lines above still
    // report if this one fails.
    expect(heading).toHaveFocus();

    unsubscribeAnnouncements(listener);
  });

  it('speaks the new page title through the status region on navigation', async () => {
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

    fireEvent.click(screen.getByRole('link', { name: 'Sources' }));

    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('Sources');
  });

  it('persists the sidebar collapse in localStorage and restores it on mount', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 })));

    const { unmount } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Home' });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem('evidence-ops-sidebar-collapsed')).toBe('true');
    unmount();

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Home' });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('titles a detail page with its record and page crumbs', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/v1/documents/versions/lookup')) {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        if (url === '/api/v1/answers/answer-1/attestation') {
          return Promise.resolve(jsonResponse({}, 404));
        }
        return Promise.resolve(
          jsonResponse({
            id: 'answer-1',
            questionText: 'What is the cap rate?',
            runStatus: 'running',
            outcome: null,
            citations: [],
            conflictIds: [],
            createdAt: new Date().toISOString(),
          }),
        );
      }),
    );

    render(
      <MemoryRouter initialEntries={['/answers/answer-1']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'What is the cap rate?' });
    // The page's own useBreadcrumbs effect, and the App-level title effect it feeds, each commit
    // one render after the heading itself, so the title settles a tick later than the heading.
    await waitFor(() =>
      expect(document.title).toBe('What is the cap rate? · Answers · Evidence Ops'),
    );
  });

  it('shows the Sign in title on /login', () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(document.title).toBe('Sign in · Evidence Ops');
  });

  it('shows admin links after a client-side login without a reload', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/v1/auth/login') {
          return Promise.resolve(
            jsonResponse({
              user: {
                id: 'admin-1',
                email: 'admin@example.com',
                role: 'admin',
                createdAt: new Date().toISOString(),
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }),
    );

    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Sign in' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('link', { name: 'Audit events' })).toBeInTheDocument();
  });

  it('clears leftover toasts on logout', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 })));
    notify('success', 'Something happened');

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Home' });
    expect(getToasts()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'user@example.com, Member' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));

    await screen.findByRole('heading', { name: 'Sign in' });
    expect(getToasts()).toHaveLength(0);
  });
});

describe('App / shell / topbar failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('./components/shell/Topbar');
    vi.resetModules();
  });

  it('renders the app-scope fallback when the topbar throws', async () => {
    // React logs every error a boundary catches to console.error on its own — expected here, not
    // a signal of an unhandled failure.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('./components/shell/Topbar', () => ({
      default: () => {
        throw new Error('topbar boom');
      },
    }));
    vi.resetModules();
    const freshAuth = await import('./lib/auth');
    vi.spyOn(freshAuth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ docs: [], count: 0 })));
    const { default: FreshApp } = await import('./App');

    render(
      <MemoryRouter initialEntries={['/']}>
        <FreshApp />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: "This page couldn't load" }),
    ).toBeInTheDocument();
  });
});
