import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function submit(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the email and password fields with a submit control', () => {
    renderPage();

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the password length rule only once account creation is in view', () => {
    renderPage();

    expect(screen.queryByText('8-72 characters', { exact: false })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Need an account? Create one' }));

    expect(screen.getByText('8-72 characters', { exact: false })).toBeInTheDocument();
  });

  it('shows the server-authored reason for a rejected sign-in, verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Invalid email or password' }, 401)),
    );

    renderPage();
    submit('user@example.com', 'wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('falls back to a connection message instead of a raw browser exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    renderPage();
    submit('user@example.com', 'correct-password');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('moves focus to the heading once the mode toggle is used', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Need an account? Create one' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Create an account' })).toHaveFocus(),
    );
  });

  it('focuses the email field when an empty form is submitted', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus());
  });

  it('attempts a sign-in with a short password rather than refusing it client-side', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        user: {
          id: 'user-1',
          email: 'user@example.com',
          role: 'member',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    submit('user@example.com', 'ab');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com', password: 'ab' });
  });

  it('renders a signup field-validation error against its field, not the form alert', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          message: 'Validation failed',
          errors: [{ field: 'email', message: 'Email is already registered' }],
        },
        400,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Need an account? Create one' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'taken@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct-horse-battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));

    expect(await screen.findByText('Email is already registered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
