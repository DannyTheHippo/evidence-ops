import { Navigate, useLocation } from 'react-router-dom';
import { loginHrefFor } from '../lib/return-to';
import { useSession } from '../lib/use-session';

/** `/invitations` is superseded by the combined member/invitation admin surface at `/people` —
 * this keeps an existing link or bookmark working by redirecting rather than 404ing. The route
 * itself carries no wrapper in `AuthenticatedRoutes.tsx`, so the page guards itself: an anonymous
 * visitor goes to sign-in with a return path back to `/people` (matching `RequireAdmin`'s own
 * redirect), and an authenticated visitor goes straight to `/people`, where `RequireAdmin` renders
 * the 403 view for a non-admin. */
export default function InvitationsPage() {
  const location = useLocation();
  const { status } = useSession();

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to={loginHrefFor(location)} replace />;
  return <Navigate to="/people" replace />;
}
