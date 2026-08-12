import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { logout } from './api/client';
import { ensureSession } from './lib/auth';
import ApprovalsPage from './pages/ApprovalsPage';
import AskPage from './pages/AskPage';
import ConflictsPage from './pages/ConflictsPage';
import DataRoomPage from './pages/DataRoomPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import WorkflowRunPage from './pages/WorkflowRunPage';

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'topnav-link is-active' : 'topnav-link';
}

type SessionStatus = 'loading' | 'authed' | 'anon';

function RequireAuth({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    // The gate fails CLOSED on its own: both the resolved-anon and the rejected-probe path land
    // on 'anon', never on 'authed'. Not relying on ensureSession() to never reject.
    ensureSession()
      .then((me) => {
        if (!cancelled) setStatus(me ? 'authed' : 'anon');
      })
      .catch(() => {
        if (!cancelled) setStatus('anon');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  async function handleLogout() {
    // Client-side logout must not depend on the server's answer: logout() already clears the
    // local session cache unconditionally (its own try/finally), so a rejected request (a CSRF
    // 403, a 500, a dropped connection) has nothing left to do here but not crash the click
    // handler — onClick={() => void handleLogout()} discards this function's return value, so an
    // uncaught rejection would otherwise surface as an unhandled promise rejection instead of
    // just navigating the user out.
    try {
      await logout();
    } catch {
      // Already handled: logout()'s own finally cleared the session regardless of this failure.
    } finally {
      navigate('/login');
    }
  }

  // Chrome visibility only, not an authorization check — RequireAuth on each route is the actual
  // gate. Route-based rather than session-based: an App-level probe would only run once on mount
  // (empty dep array) and would not notice a login that happens after that first render.
  const showChrome = location.pathname !== '/login';

  return (
    <>
      {showChrome && (
        <header className="topbar">
          <span className="brand">
            <span className="brand-mark" aria-hidden />
            Evidence Ops
          </span>
          <nav className="topnav">
            <NavLink to="/" end className={navLinkClassName}>
              Home
            </NavLink>
            <NavLink to="/documents" className={navLinkClassName}>
              Data Room
            </NavLink>
            <NavLink to="/ask" className={navLinkClassName}>
              Ask
            </NavLink>
            <NavLink to="/conflicts" className={navLinkClassName}>
              Conflicts
            </NavLink>
            <NavLink to="/approvals" className={navLinkClassName}>
              Approvals
            </NavLink>
          </nav>
          <span className="topbar-spacer" />
          <button className="btn btn--ghost btn--sm" onClick={() => void handleLogout()}>
            Logout
          </button>
        </header>
      )}
      <main className="container">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
          <Route
            path="/documents"
            element={
              <RequireAuth>
                <DataRoomPage />
              </RequireAuth>
            }
          />
          <Route
            path="/documents/:id"
            element={
              <RequireAuth>
                <DataRoomPage />
              </RequireAuth>
            }
          />
          <Route
            path="/ask"
            element={
              <RequireAuth>
                <AskPage />
              </RequireAuth>
            }
          />
          <Route
            path="/conflicts"
            element={
              <RequireAuth>
                <ConflictsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/approvals"
            element={
              <RequireAuth>
                <ApprovalsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflow-runs/:id"
            element={
              <RequireAuth>
                <WorkflowRunPage />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </>
  );
}
