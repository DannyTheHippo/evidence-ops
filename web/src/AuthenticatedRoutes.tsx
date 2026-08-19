import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { IconInfoSquare } from './components/icons';
import EmptyState from './components/ui/EmptyState';
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
import MeasuresPage from './pages/MeasuresPage';
import ResolutionRulesPage from './pages/ResolutionRulesPage';
import RunsPage from './pages/RunsPage';
import SearchPage from './pages/SearchPage';
import SourceDetailPage from './pages/SourceDetailPage';
import SourcesPage from './pages/SourcesPage';
import WorkflowRunPage from './pages/WorkflowRunPage';

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

export function RequireAuth({ children }: { children: ReactNode }) {
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

/** Everything reachable only after RequireAuth/RequireAdmin passes. Statically imported so the
 * single `lazy(() => import('./AuthenticatedRoutes'))` call in `App.tsx` resolves one dynamic
 * import against one static module graph, producing one chunk instead of one per page. */
export default function AuthenticatedRoutes() {
  return (
    <Routes>
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
}
