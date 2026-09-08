import type { BadgeTone } from '../components/ui/Badge';
import type { ApprovalState, ConflictStatus } from '../api/client';

/** The two tone maps `AdjudicationPage`'s merged queue needs for `Conflict.status` and
 * `Approval.state`. Returning a tone rather than a rendered `Badge` keeps these data mappings,
 * which is what lets them live here instead of in a component — and gives each vocabulary one
 * definition instead of one per page. */

/** Resolves the badge tone for a conflict's status: `open` is caution (needs a decision),
 * `resolved` is verified, and `dismissed` falls through to neutral. Kept as a function rather
 * than a `Record` because the fallback covers every status the union does not name explicitly. */
export function conflictStatusTone(status: ConflictStatus): BadgeTone {
  if (status === 'open') return 'caution';
  if (status === 'resolved') return 'verified';
  return 'neutral';
}

/** The badge tone each approval state carries. `pending` is caution because it is the state
 * awaiting a human decision. */
export const approvalStateTone: Record<ApprovalState, BadgeTone> = {
  pending: 'caution',
  approved: 'verified',
  rejected: 'rejected',
  timed_out: 'neutral',
};
