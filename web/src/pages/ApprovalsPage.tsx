import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  decideApproval,
  listApprovals,
  listConflicts,
  listWorkflowRuns,
  type Approval,
  type ApprovalDecision,
  type ApprovalState,
  type Conflict,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Skeleton from '../components/ui/Skeleton';
import { notify } from '../components/ui/toast';
import { useSession } from '../lib/use-session';
import { shortId } from '../lib/identifiers';

const stateTone: Record<ApprovalState, 'caution' | 'verified' | 'rejected'> = {
  pending: 'caution',
  approved: 'verified',
  rejected: 'rejected',
};

/** The value `conflict.proposedWinnerFactId` points at, formatted for display — undefined when
 *  the id names no value in `conflict.values` (data drift) or the policy proposed none. */
function conflictWinnerLabel(conflict: Conflict): string | undefined {
  const winner = conflict.values.find((value) => value.factId === conflict.proposedWinnerFactId);
  return winner ? `${winner.value} ${winner.unit}` : undefined;
}

function ApprovalRow({
  approval,
  canDecide,
  sessionResolved,
  conflict,
  onDecided,
}: {
  approval: Approval;
  canDecide: boolean;
  sessionResolved: boolean;
  conflict?: Conflict;
  onDecided: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog's own open/decision-direction state — set only from the admin-gated row buttons
  // below, so a non-admin never has a path to open it.
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);
  const [viewingRun, setViewingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const winnerLabel = conflict ? conflictWinnerLabel(conflict) : undefined;

  function closeDialog() {
    setPendingDecision(null);
    setReason('');
    setError(null);
  }

  async function decide(decision: ApprovalDecision) {
    setDeciding(true);
    setError(null);
    try {
      await decideApproval(approval.id, decision, reason.trim() || undefined);
      notify(
        'success',
        decision === 'approved'
          ? 'Approval recorded — the workflow resumes.'
          : 'Rejection recorded — the workflow resumes.',
      );
      setPendingDecision(null);
      setReason('');
      onDecided(approval.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to record decision');
    } finally {
      setDeciding(false);
    }
  }

  async function viewRun() {
    const workflowId = approval.workflowId;
    if (!workflowId) return;
    setViewingRun(true);
    setRunError(null);
    try {
      const { docs } = await listWorkflowRuns({ workflowId });
      const run = docs[0];
      if (!run) {
        setRunError('No run found for this workflow.');
        return;
      }
      await navigate(`/workflow-runs/${run.id}`);
    } catch (err: unknown) {
      setRunError(err instanceof Error ? err.message : 'Failed to load workflow run');
    } finally {
      setViewingRun(false);
    }
  }

  return (
    <li className="card">
      <div className="card-head">
        <h2 className="card-title">{approval.summary}</h2>
        <Badge tone={stateTone[approval.state]}>{approval.state}</Badge>
      </div>

      {approval.requestedBy && <p className="cell-sub">Requested by {approval.requestedBy}</p>}
      {/* The summary above already says what is being approved; the raw entity id is a lookup
          key, shown truncated with the full value on hover rather than as a wall of hex. */}
      <p className="cell-sub">
        {approval.subject.entityType}{' '}
        <span className="mono" title={approval.subject.entityId}>
          {shortId(approval.subject.entityId)}
        </span>
      </p>
      <p className="cell-sub">Requested {new Date(approval.createdAt).toLocaleString()}</p>

      {conflict &&
        (conflict.ruleFired === 'none' ? (
          <p className="cell-sub">
            Policy has no recommendation for this conflict — {conflict.explanation}
          </p>
        ) : (
          <>
            <Badge tone="info">Recommended · {conflict.ruleFired}</Badge>
            <p className="cell-sub">
              {winnerLabel ? `${winnerLabel} — ` : ''}
              {conflict.explanation}
            </p>
          </>
        ))}

      <div className="form-actions">
        {canDecide && (
          <>
            <Button variant="primary" onClick={() => setPendingDecision('approved')}>
              Approve
            </Button>
            <Button variant="secondary" onClick={() => setPendingDecision('rejected')}>
              Reject
            </Button>
          </>
        )}
        {/* The server's RolesGuard is the actual gate — this notice only explains an absence the
            API would enforce anyway, rather than showing a control that fails on click. It waits
            for the session probe to land, so an admin is never told they are not one. */}
        {sessionResolved && !canDecide && (
          <p className="cell-sub">Deciding approvals requires an admin.</p>
        )}
        {approval.workflowId && (
          <Button variant="ghost" disabled={viewingRun} onClick={() => void viewRun()}>
            {viewingRun ? 'Loading…' : 'View run'}
          </Button>
        )}
      </div>

      {runError && (
        <p className="error" role="alert">
          {runError}
        </p>
      )}

      <Dialog
        open={pendingDecision !== null}
        onClose={closeDialog}
        title={pendingDecision === 'rejected' ? 'Reject this approval' : 'Approve this approval'}
      >
        <div className="form">
          <p>{approval.summary}</p>
          <p className="cell-sub">
            {approval.workflowId
              ? 'This decision resumes the parked workflow run.'
              : 'This decision will be recorded.'}
          </p>
          <Field label="Reason (optional)">
            {(inputProps) => (
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Evidence checks out."
                disabled={deciding}
                {...inputProps}
              />
            )}
          </Field>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <Button
              variant={pendingDecision === 'rejected' ? 'danger' : 'primary'}
              disabled={deciding}
              onClick={() => pendingDecision && void decide(pendingDecision)}
            >
              {pendingDecision === 'rejected' ? 'Reject' : 'Approve'}
            </Button>
            <Button variant="ghost" disabled={deciding} onClick={closeDialog}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </li>
  );
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [conflictsById, setConflictsById] = useState<Map<string, Conflict>>(new Map());
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the decide controls flash in before the check lands.
  const canDecide = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useEffect(() => {
    listApprovals()
      .then(({ docs, count: total }) => {
        setApprovals(docs);
        setCount(total);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load approvals');
      });
  }, []);

  // A conflict-resolution approval carries no proposal of its own — `subject.entityId` is the
  // conflict id, and the proposal (winner, rule, explanation) lives on the conflict. Fetched only
  // once there is a conflict-backed approval to annotate; failure here must not affect the
  // approvals list, same reasoning as the document-index fetch on ConflictsPage.
  useEffect(() => {
    if (!approvals?.some((approval) => approval.subject.entityType === 'Conflict')) return;
    let cancelled = false;

    listConflicts()
      .then(({ docs }) => {
        if (!cancelled) setConflictsById(new Map(docs.map((conflict) => [conflict.id, conflict])));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [approvals]);

  // A decided approval leaves the pending inbox — this page's own GET /approvals call is
  // unfiltered and the server defaults an unfiltered request to pending rows, so removing it
  // locally on success matches what a re-fetch would show anyway.
  function handleDecided(id: string) {
    setApprovals((current) => current?.filter((approval) => approval.id !== id) ?? current);
    setCount((current) => Math.max(0, current - 1));
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Workflow</span>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">Pending human decisions gating a workflow run.</p>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!approvals && !error && <Skeleton label="Loading…" />}

      {approvals && approvals.length === 0 && (
        <EmptyState
          title="Nothing waiting on you"
          description="Every approval has been decided. New requests appear here as workflows park on them."
        />
      )}

      {approvals && approvals.length > 0 && approvals.length < count && (
        <p className="cell-sub">
          Showing {approvals.length} of {count}.
        </p>
      )}

      <ul className="approval-list">
        {approvals?.map((approval) => (
          <ApprovalRow
            key={approval.id}
            approval={approval}
            canDecide={canDecide}
            sessionResolved={sessionResolved}
            conflict={
              approval.subject.entityType === 'Conflict'
                ? conflictsById.get(approval.subject.entityId)
                : undefined
            }
            onDecided={handleDecided}
          />
        ))}
      </ul>
    </div>
  );
}
