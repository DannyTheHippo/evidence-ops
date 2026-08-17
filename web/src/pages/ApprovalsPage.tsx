import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  decideApproval,
  listApprovals,
  listConflicts,
  listWorkflowRuns,
  type Approval,
  type ApprovalDecision,
  type Conflict,
} from '../api/client';
import { useSession } from '../lib/use-session';

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
  const [viewingRun, setViewingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const winnerLabel = conflict ? conflictWinnerLabel(conflict) : undefined;

  async function decide(decision: ApprovalDecision) {
    setDeciding(true);
    setError(null);
    try {
      await decideApproval(approval.id, decision, reason.trim() || undefined);
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
        <span className="badge badge--possible">
          <span className="badge-dot" />
          pending
        </span>
      </div>

      {approval.requestedBy && <p className="cell-sub">Requested by {approval.requestedBy}</p>}
      <p className="cell-sub">
        {approval.subject.entityType} {approval.subject.entityId}
      </p>
      <p className="cell-sub">Requested {new Date(approval.createdAt).toLocaleString()}</p>

      {conflict &&
        (conflict.ruleFired === 'none' ? (
          <p className="cell-sub">
            Policy has no recommendation for this conflict — {conflict.explanation}
          </p>
        ) : (
          <>
            <span className="badge badge--info">
              <span className="badge-dot" />
              Recommended · {conflict.ruleFired}
            </span>
            <p className="cell-sub">
              {winnerLabel ? `${winnerLabel} — ` : ''}
              {conflict.explanation}
            </p>
          </>
        ))}

      <div className="form">
        {canDecide && (
          <label>
            Reason (optional)
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Evidence checks out."
              disabled={deciding}
            />
          </label>
        )}
        <div className="form-actions">
          {canDecide && (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={deciding}
                onClick={() => void decide('approved')}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={deciding}
                onClick={() => void decide('rejected')}
              >
                Reject
              </button>
            </>
          )}
          {/* The server's RolesGuard is the actual gate — this notice only explains an absence the
              API would enforce anyway, rather than showing a control that fails on click. It waits
              for the session probe to land, so an admin is never told they are not one. */}
          {sessionResolved && !canDecide && (
            <p className="cell-sub">Deciding approvals requires an admin.</p>
          )}
          {approval.workflowId && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={viewingRun}
              onClick={() => void viewRun()}
            >
              {viewingRun ? 'Loading…' : 'View run'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {runError && (
        <p className="error" role="alert">
          {runError}
        </p>
      )}
    </li>
  );
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictsById, setConflictsById] = useState<Map<string, Conflict>>(new Map());
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the decide controls flash in before the check lands.
  const canDecide = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useEffect(() => {
    listApprovals()
      .then(({ docs }) => setApprovals(docs))
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

  // A decided approval leaves the pending inbox — GET /approvals only ever returns pending
  // rows, so removing it locally on success matches what a re-fetch would show anyway.
  function handleDecided(id: string) {
    setApprovals((current) => current?.filter((approval) => approval.id !== id) ?? current);
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

      {!approvals && !error && <p>Loading…</p>}

      {approvals && approvals.length === 0 && (
        <p className="notice notice--info">No pending approvals.</p>
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
