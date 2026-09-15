import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import LoginPage from './LoginPage';

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ME_URL = '/api/v1/auth/me';
const LOGIN_URL = '/api/v1/auth/login';
const REGISTER_URL = '/api/v1/auth/register';

const signedInUser = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'member' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// Dispatches by URL, matching PeoplePage.test.tsx's stubFetch shape. `session` defaults to
// anonymous — an anonymous visitor is who normally lands on /login — and every test now fetches
// `/auth/me`, since the page renders a notice for a visitor who already has one.
function stubFetch(
  routes: Record<string, RouteHandler> = {},
  session: RouteHandler = () => new Response(null, { status: 401 }),
): ReturnType<typeof vi.fn> {
  const defaults: Record<string, RouteHandler> = {
    [ME_URL]: session,
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

// Exposes the current location as accessible text, since `MemoryRouter` gives a test no other way
// to read where a navigate() call landed — matches ApiKeysPage.test.tsx's LocationProbe.
function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="current location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderPage(initialEntries: string[] = ['/login']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LoginPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function submit(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

function openSignup(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Need a workspace? Create a new workspace' }));
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('renders the email and password fields with a submit control', () => {
    stubFetch();
    renderPage();

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the password length rule only once account creation is in view', () => {
    stubFetch();
    renderPage();

    expect(screen.queryByText('8–72 characters', { exact: false })).not.toBeInTheDocument();

    openSignup();

    expect(screen.getByText('8–72 characters', { exact: false })).toBeInTheDocument();
  });

  it('shows the server-authored reason for a rejected sign-in, verbatim', async () => {
    stubFetch({ [LOGIN_URL]: () => jsonResponse({ message: 'Invalid email or password' }, 401) });

    renderPage();
    submit('user@example.com', 'wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('falls back to a connection message instead of a raw browser exception', async () => {
    stubFetch({ [LOGIN_URL]: () => Promise.reject(new TypeError('Failed to fetch')) });

    renderPage();
    submit('user@example.com', 'correct-password');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('moves focus to the heading once the mode toggle is used', async () => {
    stubFetch();
    renderPage();

    openSignup();

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Create a new workspace' })).toHaveFocus(),
    );
  });

  it('focuses the email field when an empty form is submitted', async () => {
    stubFetch();
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus());
  });

  it('attempts a sign-in with a short password rather than refusing it client-side', async () => {
    const fetchMock = stubFetch({ [LOGIN_URL]: () => jsonResponse({ user: signedInUser }) });

    renderPage();
    submit('user@example.com', 'ab');

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === LOGIN_URL)).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === LOGIN_URL) as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com', password: 'ab' });
  });

  it('renders a signup field-validation error against its field, not the form alert', async () => {
    stubFetch({
      [REGISTER_URL]: () =>
        jsonResponse(
          {
            message: 'Validation failed',
            errors: [{ field: 'email', message: 'Email is already registered' }],
          },
          400,
        ),
    });

    renderPage();
    openSignup();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'taken@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct-horse-battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByText('Email is already registered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('returns to the deep link recorded in ?next= after signing in', async () => {
    stubFetch({ [LOGIN_URL]: () => jsonResponse({ user: signedInUser }) });

    renderPage(['/login?next=%2Fsources']);
    submit('user@example.com', 'correct-password');

    await waitFor(() =>
      expect(screen.getByLabelText('current location')).toHaveTextContent('/sources'),
    );
  });

  it.each([
    { family: 'a tab between slashes', next: '%2F%09%2Fevil.example' },
    { family: 'a backslash after the slash', next: '%2F%5Cevil.example' },
  ])('lands on / after signing in when ?next= carries $family', async ({ next }) => {
    stubFetch({ [LOGIN_URL]: () => jsonResponse({ user: signedInUser }) });

    renderPage([`/login?next=${next}`]);
    submit('user@example.com', 'correct-password');

    await waitFor(() => expect(screen.getByLabelText('current location').textContent).toBe('/'));
  });

  it.each([
    { family: 'a tab between slashes', next: '%2F%09%2Fevil.example' },
    { family: 'a backslash after the slash', next: '%2F%5Cevil.example' },
  ])(
    'points the already-signed-in Continue link at / when ?next= carries $family',
    async ({ next }) => {
      stubFetch({}, () => jsonResponse(signedInUser));

      renderPage([`/login?next=${next}`]);

      expect(await screen.findByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/');
    },
  );

  it('sends a pasted address with trailing whitespace trimmed', async () => {
    const fetchMock = stubFetch({ [LOGIN_URL]: () => jsonResponse({ user: signedInUser }) });

    renderPage();
    submit('  user@example.com  ', 'correct-password');

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === LOGIN_URL)).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === LOGIN_URL) as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'user@example.com',
      password: 'correct-password',
    });
  });

  it('names the sign-up path as creating a separate workspace', () => {
    stubFetch();
    renderPage();

    openSignup();

    expect(screen.getByRole('heading', { name: 'Create a new workspace' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "This creates a new, separate workspace with you as its admin. Joining a colleague's workspace happens through their invitation link, not here.",
      ),
    ).toBeInTheDocument();
  });

  it('tells a signed-in visitor they already have a session', async () => {
    stubFetch({}, () => jsonResponse(signedInUser));

    renderPage();

    expect(await screen.findByText("You're already signed in.")).toBeInTheDocument();
  });
});
