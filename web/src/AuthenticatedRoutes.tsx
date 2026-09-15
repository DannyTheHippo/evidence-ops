import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Button from './components/ui/Button';
import LinkButton from './components/ui/LinkButton';
import { useBreadcrumbs } from './lib/breadcrumbs';
import { loginHrefFor } from './lib/return-to';
import { useSession } from './lib/use-session';
import AdjudicationPage from './pages/AdjudicationPage';
import AnswerDetailPage from './pages/AnswerDetailPage';
import AnswersPage from './pages/AnswersPage';
import ApiKeysPage from './pages/ApiKeysPage';
import AuditEventsPage from './pages/AuditEventsPage';
import CanonicalEntitiesPage from './pages/CanonicalEntitiesPage';
import DataRoomPage from './pages/DataRoomPage';
import DocumentWorkbenchPage from './pages/DocumentWorkbenchPage';
import HomePage from './pages/HomePage';
import InvitationsPage from './pages/InvitationsPage';
import LedgerPage from './pages/LedgerPage';
import MeasuresPage from './pages/MeasuresPage';
import PeoplePage from './pages/PeoplePage';
import RunsPage from './pages/RunsPage';
import SourceDetailPage from './pages/SourceDetailPage';
import SourcesPage from './pages/SourcesPage';
import VerificationDetailPage from './pages/VerificationDetailPage';
import WorkflowRunPage from './pages/WorkflowRunPage';

function NotFoundView() {
  const location = useLocation();
  const navigate = useNavigate();
  useBreadcrumbs([{ label: 'Page not found' }]);

  return (
    <div className="fault">
      <p className="fault-eyebrow mono">HTTP 404</p>
      <h1 className="fault-title" tabIndex={-1}>
        Page not found
      </h1>
      <p className="fault-description">
        The page you&apos;re looking for doesn&apos;t exist. Head back to somewhere that does.
      </p>
      <p className="fault-detail mono">{location.pathname}</p>
      <div className="fault-actions">
        <LinkButton to="/">Go to Home</LinkButton>
        <Button variant="ghost" onClick={() => void navigate(-1)}>
          Go back
        </Button>
      </div>
    </div>
  );
}

function ForbiddenView() {
  const navigate = useNavigate();
  useBreadcrumbs([{ label: 'Not allowed' }]);

  return (
    <div className="fault">
      <p className="fault-eyebrow mono">HTTP 403</p>
      <h1 className="fault-title" tabIndex={-1}>
        You don&apos;t have access to this page
      </h1>
      <p className="fault-description">
        This page needs the Admin role. Ask an admin to change your role, or head back.
      </p>
      <div className="fault-actions">
        <LinkButton to="/">Go to Home</LinkButton>
        <Button variant="ghost" onClick={() => void navigate(-1)}>
          Go back
        </Button>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  // useSession() already fails CLOSED — a rejected probe resolves to 'anon', never 'authed'.
  const location = useLocation();
  const { status } = useSession();

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to={loginHrefFor(location)} replace />;
  return <>{children}</>;
}

// Composes with RequireAuth by nesting: RequireAuth turns an unauthenticated visit into a
// redirect to /login, RequireAdmin additionally turns an authenticated-but-non-admin visit into
// the 403 view. Both read the same useSession() cache, so wrapping a route in both never issues a
// second session probe.
//
// This is a display convenience, not the security boundary — it only decides what the SPA
// renders. Every admin-gated endpoint carries its own server-side role check (`RolesGuard` +
// `@RequireRole(Admin)`) that a hidden or redirected route can never bypass.
export function RequireAdmin({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { status, me } = useSession();

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to={loginHrefFor(location)} replace />;
  if (me.role !== 'admin') return <ForbiddenView />;
  return <>{children}</>;
}

/** Every authenticated route, covering the five sidebar groups (Home, Estate, Ledger, Work,
 * Admin) — the Ledger group itself is open to every member, but its Entities item is gated on its
 * own (hidden from Sidebar for a non-admin, and behind `RequireAdmin` here) — and the ungated
 * `/invitations` shim. Statically imported so the single `lazy(() => import('./AuthenticatedRoutes'))`
 * call in `App.tsx` resolves one dynamic import against one static module graph, producing one
 * chunk instead of one per page. */
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
        path="/answers/verifications/:id"
        element={
          <RequireAuth>
            <VerificationDetailPage />
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
        path="/documents/:documentId/versions/:versionId"
        element={
          <RequireAuth>
            <DocumentWorkbenchPage />
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
        path="/ledger"
        element={
          <RequireAuth>
            <LedgerPage />
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
        path="/adjudication"
        element={
          <RequireAuth>
            <AdjudicationPage />
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
        path="/people"
        element={
          <RequireAdmin>
            <PeoplePage />
          </RequireAdmin>
        }
      />
      <Route path="/invitations" element={<InvitationsPage />} />
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
