import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  decideApproval,
  listWorkflowRuns,
  type Approval,
  type ApprovalDecision,
  type Conflict,
} from '../../api/client';
import ApprovalDecisionDialog from '../../components/ApprovalDecisionDialog';
import ConflictValueCompare from '../../components/ConflictValueCompare';
import Alert from '../../components/ui/Alert';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import CopyButton from '../../components/ui/CopyButton';
import DescriptionList from '../../components/ui/DescriptionList';
import LinkButton from '../../components/ui/LinkButton';
import Timestamp from '../../components/ui/Timestamp';
import { notify } from '../../components/ui/toast';
import { approvalStateTone } from '../../lib/adjudication-status';
import type { ResolvedVersion } from '../../lib/document-index';
import { shortId } from '../../lib/identifiers';
import { metricLabel } from '../../lib/metric-labels';

interface DecisionCaseProps {
  approval: Approval;
  conflict?: Conflict;
  metricLabels: Record<string, string>;
  documentIndex: Map<string, ResolvedVersion>;
  canDecide: boolean;
  sessionResolved: boolean;
  /** Called after the server has accepted the decision. `refetch` asks the page to reload the
   * current queue page — set on a 404/409, where local removal would not match the server. */
  onDecided: (id: string, options?: { refetch?: boolean }) => void;
}

/** The adjudication pane for one approval: what is being decided and, once decided, who decided
 *  it and why. A conflict-resolution approval additionally shows the fact key plus the read-only
 *  `ConflictValueCompare`, which renders the policy's own proposal strip — so the recommendation
 *  is stated once, alongside the sourced evidence it was drawn from. */
export default function DecisionCase({
  approval,
  conflict,
  metricLabels,
  documentIndex,
  canDecide,
  sessionResolved,
  onDecided,
}: DecisionCaseProps) {
  const navigate = useNavigate();
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);
  const [viewingRun, setViewingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

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

  async function handleConfirm(decision: ApprovalDecision, reason: string | undefined) {
    try {
      await decideApproval(approval.id, decision, reason);
    } catch (err: unknown) {
      // A 404/409 means the server already moved this approval past pending — re-offering the
      // dialog would only 409 again, so the page refetches instead of removing the row locally.
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        setPendingDecision(null);
        notify('error', 'This approval was already decided. Refreshing the queue.');
        onDecided(approval.id, { refetch: true });
        return;
      }
      throw err;
    }
    notify(
      'success',
      decision === 'approved'
        ? 'Approved — the workflow resumes.'
        : 'Rejected — the workflow resumes.',
    );
    setPendingDecision(null);
    onDecided(approval.id);
  }

  const detailItems = [
    { term: 'Requested', description: <Timestamp value={approval.createdAt} /> },
    ...(approval.requestedBy ? [{ term: 'Requested by', description: approval.requestedBy }] : []),
    {
      term: 'Subject',
      description: (
        <>
          {approval.subject.entityType}{' '}
          <span className="mono">{shortId(approval.subject.entityId)}</span>{' '}
          <CopyButton text={approval.subject.entityId} label="Copy subject id" iconOnly />
        </>
      ),
    },
    ...(approval.state !== 'pending' && approval.decidedAt
      ? [
          {
            term: 'Decided',
            description: (
              <>
                <Timestamp value={approval.decidedAt} />
                {approval.decidedBy ? ` by ${approval.decidedBy}` : ''}
              </>
            ),
          },
        ]
      : []),
    ...(approval.decisionReason ? [{ term: 'Reason', description: approval.decisionReason }] : []),
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="card-title">{approval.summary}</h2>
        <Badge tone={approvalStateTone[approval.state]}>{approval.state}</Badge>
      </div>

      <DescriptionList columns={2} items={detailItems} />

      {conflict && (
        <>
          <p className="cell-sub">
            {conflict.factKey.entity} · {metricLabel(conflict.factKey.metric, metricLabels)} ·{' '}
            {conflict.factKey.period}
          </p>
          <ConflictValueCompare
            values={conflict.values}
            proposedWinnerFactId={conflict.proposedWinnerFactId}
            ruleFired={conflict.ruleFired}
            explanation={conflict.explanation}
            documentIndex={documentIndex}
          />
          <LinkButton
            to={`/adjudication?kind=conflicts&selected=${conflict.id}`}
            variant="ghost"
            size="sm"
          >
            View conflict
          </LinkButton>
        </>
      )}

      <div className="form-actions">
        {/* `decide()` (`approvals.service.ts`) rejects a non-pending approval outright, so the
            filter above can surface an already-decided approval without offering controls that
            would only 409. */}
        {canDecide && approval.state === 'pending' && (
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
        {sessionResolved && !canDecide && approval.state === 'pending' && (
          <p className="cell-sub">Deciding approvals requires an admin.</p>
        )}
        {approval.workflowId && (
          <Button variant="ghost" disabled={viewingRun} onClick={() => void viewRun()}>
            {viewingRun ? 'Viewing…' : 'View run'}
          </Button>
        )}
      </div>

      {runError && <Alert tone="rejected">{runError}</Alert>}

      <ApprovalDecisionDialog
        decision={pendingDecision}
        summary={approval.summary}
        resumesWorkflow={!!approval.workflowId}
        onClose={() => setPendingDecision(null)}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
