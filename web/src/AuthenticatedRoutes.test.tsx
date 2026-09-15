import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthenticatedRoutes, { RequireAdmin, RequireAuth } from './AuthenticatedRoutes';
import * as auth from './lib/auth';

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

  it('a member sees the 403 view, not Home, with a level-1 heading', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-2',
      email: 'member@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });

    renderRequireAdmin();

    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access to this page" }),
    ).toBeInTheDocument();
    expect(screen.queryByText('admin content')).not.toBeInTheDocument();
    expect(screen.queryByText('home probe')).not.toBeInTheDocument();
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

function LoginProbe() {
  const location = useLocation();
  return <p>login probe · {location.search}</p>;
}

describe('RequireAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends an anonymous deep link to /login with next set', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={['/documents/abc?skip=20']}>
        <Routes>
          <Route
            path="/documents/abc"
            element={
              <RequireAuth>
                <p>protected content</p>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    const expectedSearch = `?next=${encodeURIComponent('/documents/abc?skip=20')}`;
    expect(await screen.findByText(`login probe · ${expectedSearch}`)).toBeInTheDocument();
  });
});

describe('NotFoundView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a level-1 heading', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    });

    render(
      <MemoryRouter initialEntries={['/nonexistent-route']}>
        <AuthenticatedRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
  });
});
