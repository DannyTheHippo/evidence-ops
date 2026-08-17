import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { logout } from './api/client';
import { useSession } from './lib/use-session';
import ApiKeysPage from './pages/ApiKeysPage';
import ApprovalsPage from './pages/ApprovalsPage';
import AskPage from './pages/AskPage';
import AuditEventsPage from './pages/AuditEventsPage';
import ConflictsPage from './pages/ConflictsPage';
import DataRoomPage from './pages/DataRoomPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import SourceDetailPage from './pages/SourceDetailPage';
import SourcesPage from './pages/SourcesPage';
import WorkflowRunPage from './pages/WorkflowRunPage';

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'topnav-link is-active' : 'topnav-link';
}

function RequireAuth({ children }: { children: ReactNode }) {
  // useSession() already fails CLOSED — a rejected probe resolves to 'anon', never 'authed'.
  const { status } = useSession();

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Composes with RequireAuth by nesting: RequireAuth turns an unauthenticated visit into a
// redirect to /login, RequireAdmin additionally turns an authenticated-but-non-admin visit into
// a redirect to /. Both read the same useSession() cache, so wrapping a route in both never
// issues a second session probe.
//
// This is a display convenience, not the security boundary — it only decides what the SPA
// renders. Every admin-gated endpoint carries its own server-side role check (`RolesGuard` +
// `@RequireRole(Admin)`) that a hidden or redirected route can never bypass.
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, me } = useSession();

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to="/login" replace />;
  if (me.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  // Same "don't show a control that fails" principle as RequireAdmin itself — a member never
  // sees a link to a page RequireAdmin would immediately bounce them off of.
  const isAdmin = session.status === 'authed' && session.me.role === 'admin';

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
      await navigate('/login');
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
            <NavLink to="/sources" className={navLinkClassName}>
              Sources
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
            <NavLink to="/api-keys" className={navLinkClassName}>
              API Keys
            </NavLink>
            {isAdmin && (
              <NavLink to="/audit-events" className={navLinkClassName}>
                Audit Log
              </NavLink>
            )}
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
            path="/sources"
            element={
              <RequireAuth>
                <SourcesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/sources/:id"
            element={
              <RequireAuth>
                <SourceDetailPage />
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
            path="/api-keys"
            element={
              <RequireAuth>
                <ApiKeysPage />
              </RequireAuth>
            }
          />
          <Route
            path="/audit-events"
            element={
              <RequireAdmin>
                <AuditEventsPage />
              </RequireAdmin>
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
