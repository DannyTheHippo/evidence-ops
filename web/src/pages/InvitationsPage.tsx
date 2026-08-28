import { Navigate } from 'react-router-dom';

/** `/invitations` is superseded by the combined member/invitation admin surface at `/people` —
 * this keeps an existing link or bookmark working by redirecting rather than 404ing. */
export default function InvitationsPage() {
  return <Navigate to="/people" replace />;
}
