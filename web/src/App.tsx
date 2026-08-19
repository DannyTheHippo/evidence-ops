import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { logout } from './api/client';
import { IconInfoSquare } from './components/icons';
import Sidebar, { NAV_LABELS } from './components/shell/Sidebar';
import Topbar from './components/shell/Topbar';
import EmptyState from './components/ui/EmptyState';
import Toaster from './components/ui/Toaster';
import { useSession } from './lib/use-session';
import AnswerDetailPage from './pages/AnswerDetailPage';
import AnswersPage from './pages/AnswersPage';
import ApiKeysPage from './pages/ApiKeysPage';
import ApprovalsPage from './pages/ApprovalsPage';
import AskPage from './pages/AskPage';
import AuditEventsPage from './pages/AuditEventsPage';
import CanonicalEntitiesPage from './pages/CanonicalEntitiesPage';
import ConflictsPage from './pages/ConflictsPage';
import DataRoomPage from './pages/DataRoomPage';
import HomePage from './pages/HomePage';
import InvitationsPage from './pages/InvitationsPage';
import InvitePage from './pages/InvitePage';
import LoginPage from './pages/LoginPage';
import MeasuresPage from './pages/MeasuresPage';
import ResolutionRulesPage from './pages/ResolutionRulesPage';
import RunsPage from './pages/RunsPage';
import SearchPage from './pages/SearchPage';
import SourceDetailPage from './pages/SourceDetailPage';
import SourcesPage from './pages/SourcesPage';
import WorkflowRunPage from './pages/WorkflowRunPage';

/** The nearest nav destination that owns `pathname` — an exact match first, then the longest nav
 * `to` that prefixes it, so a detail route like `/sources/:id` breadcrumbs to "Sources" rather
 * than falling back to the brand. */
const SIDEBAR_STORAGE_KEY = 'evidence-ops-sidebar-collapsed';

// Layout preference: fails OPEN. Any storage error (disabled storage, quota, privacy mode) leaves
// the sidebar expanded rather than blocking render — the nav is reachable either way.
function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function breadcrumbFor(pathname: string): string {
  const exact = NAV_LABELS.find((item) => item.to === pathname);
  if (exact) return exact.label;

  const prefixMatch = NAV_LABELS.filter(
    (item) => item.to !== '/' && pathname.startsWith(`${item.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];

  return prefixMatch?.label ?? 'Evidence Ops';
}

function NotFoundView() {
  return (
    <EmptyState
      icon={<IconInfoSquare size={24} />}
      title="Page not found"
      description="The page you're looking for doesn't exist. Head back to somewhere that does."
      action={
        <Link to="/" className="btn btn--primary">
          Go to Home
        </Link>
      }
    />
  );
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readStoredCollapsed());

  // Derived outside the setState updater deliberately: StrictMode double-invokes updaters, so a
  // write placed inside one runs twice per click.
  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      // storage unavailable — the toggle still applies for this session, just not the next
    }
  }

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
  const showChrome = location.pathname !== '/login' && location.pathname !== '/invite';

  const routes = (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route
        path="/measures"
        element={
          <RequireAuth>
            <MeasuresPage />
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
        path="/answers"
        element={
          <RequireAuth>
            <AnswersPage />
          </RequireAuth>
        }
      />
      <Route
        path="/answers/:id"
        element={
          <RequireAuth>
            <AnswerDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/search"
        element={
          <RequireAuth>
            <SearchPage />
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
        path="/workflow-runs"
        element={
          <RequireAuth>
            <RunsPage />
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
        path="/invitations"
        element={
          <RequireAdmin>
            <InvitationsPage />
          </RequireAdmin>
        }
      />
      <Route
        path="/resolution-rules"
        element={
          <RequireAdmin>
            <ResolutionRulesPage />
          </RequireAdmin>
        }
      />
      <Route
        path="/canonical-entities"
        element={
          <RequireAdmin>
            <CanonicalEntitiesPage />
          </RequireAdmin>
        }
      />
      <Route
        path="*"
        element={
          <RequireAuth>
            <NotFoundView />
          </RequireAuth>
        }
      />
    </Routes>
  );

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {showChrome ? (
        <div className="shell">
          <Sidebar
            isAdmin={isAdmin}
            drawerOpen={drawerOpen}
            onCloseDrawer={() => setDrawerOpen(false)}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
          />
          <div className="shell-main">
            <Topbar
              breadcrumbLabel={breadcrumbFor(location.pathname)}
              onOpenMenu={() => setDrawerOpen(true)}
              onLogout={() => void handleLogout()}
            />
            <main id="main-content" tabIndex={-1} className="container">
              {routes}
            </main>
          </div>
        </div>
      ) : (
        <main id="main-content" tabIndex={-1} className="container">
          {routes}
        </main>
      )}
      <Toaster />
    </>
  );
}
