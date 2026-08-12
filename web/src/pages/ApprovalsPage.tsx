import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  decideApproval,
  listApprovals,
  listWorkflowRuns,
  type Approval,
  type ApprovalDecision,
} from '../api/client';

function ApprovalRow({
  approval,
  onDecided,
}: {
  approval: Approval;
  onDecided: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewingRun, setViewingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

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
      navigate(`/workflow-runs/${run.id}`);
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

      <div className="form">
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
        <div className="form-actions">
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

  useEffect(() => {
    listApprovals()
      .then(({ docs }) => setApprovals(docs))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load approvals');
      });
  }, []);

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
          <ApprovalRow key={approval.id} approval={approval} onDecided={handleDecided} />
        ))}
      </ul>
    </div>
  );
}
