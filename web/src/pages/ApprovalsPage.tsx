import { useEffect, useRef, useState, type FormEvent } from 'react';
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
import { IconCheck } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import { notify } from '../components/ui/toast';
import { useSession } from '../lib/use-session';
import { shortId } from '../lib/identifiers';

const PAGE_SIZE = 20;

// No "All states" entry — the server substitutes `pending` when the param is omitted
// (`approvals.service.ts`'s `peekPending`), so omitting the filter never means "every state".
const STATE_OPTIONS: { value: ApprovalState; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'timed_out', label: 'Timed out' },
];

const stateTone: Record<ApprovalState, 'caution' | 'verified' | 'rejected' | 'neutral'> = {
  pending: 'caution',
  approved: 'verified',
  rejected: 'rejected',
  timed_out: 'neutral',
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
  // Blocks a double submit between the click and the re-render that disables the dialog's own
  // buttons — `disabled={deciding}` alone only takes effect once React has committed it, the same
  // reasoning `AskPage.tsx`'s `submitInFlightRef` documents. A stale `pending` row rendered after
  // another tab already decided it is a live Approve/Reject button aimed at a decided approval;
  // the server's own `state: 'pending'` guard (`ApprovalsService.decide`) still rejects the second
  // write, but this stops the SPA from firing it at all.
  const submitInFlightRef = useRef(false);

  function closeDialog() {
    setPendingDecision(null);
    setReason('');
    setError(null);
  }

  async function decide(decision: ApprovalDecision) {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setDeciding(true);
    setError(null);
    try {
      await decideApproval(approval.id, decision, reason.trim() || undefined);
      notify(
        'success',
        decision === 'approved'
          ? 'Approved — the workflow resumes.'
          : 'Rejected — the workflow resumes.',
      );
      setPendingDecision(null);
      setReason('');
      onDecided(approval.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to record decision');
    } finally {
      setDeciding(false);
      submitInFlightRef.current = false;
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
      {approval.state !== 'pending' && approval.decidedAt && (
        <p className="cell-sub">
          Decided {new Date(approval.decidedAt).toLocaleString()}
          {approval.decidedBy ? ` by ${approval.decidedBy}` : ''}
        </p>
      )}
      {approval.decisionReason && <p className="cell-sub">Reason: {approval.decisionReason}</p>}

      {conflict &&
        (conflict.ruleFired === 'none' ? (
          <p className="cell-sub">
            Policy has no recommendation for this conflict — {conflict.explanation}
          </p>
        ) : (
          <>
            <Badge tone="info">recommended · {conflict.ruleFired}</Badge>
            <p className="cell-sub">
              {winnerLabel ? `${winnerLabel} — ` : ''}
              {conflict.explanation}
            </p>
          </>
        ))}

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
  const [skip, setSkip] = useState(0);
  const [state, setState] = useState<ApprovalState>('pending');
  // Only this, not `state` itself, drives the fetch — the filter applies on submit, not on every
  // selection change (AnswersPage.tsx follows the same split). There is no "unset" value to fall
  // back to — every option is a concrete state, matching what the server actually filters on.
  const [appliedState, setAppliedState] = useState<ApprovalState>('pending');
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the decide controls flash in before the check lands.
  const canDecide = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useEffect(() => {
    let cancelled = false;

    listApprovals({ skip, limit: PAGE_SIZE, state: appliedState })
      .then(({ docs, count: total }) => {
        if (cancelled) return;
        setApprovals(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load approvals');
      });

    return () => {
      cancelled = true;
    };
  }, [skip, appliedState]);

  function handleFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSkip(0);
    setAppliedState(state);
  }

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

  // A decided approval leaves the pending inbox — decide controls only render on a pending-state
  // row (`decide()` in `approvals.service.ts` rejects anything else), so removing it locally on
  // success matches what a re-fetch of the pending filter would show anyway.
  function handleDecided(id: string) {
    setApprovals((current) => current?.filter((approval) => approval.id !== id) ?? current);
    setCount((current) => Math.max(0, current - 1));
  }

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Review</span>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">Pending human decisions gating a workflow run.</p>
        </div>
      </div>

      <form onSubmit={handleFilter} className="control-row">
        <Select
          label="State"
          options={STATE_OPTIONS}
          value={state}
          onChange={(value) => setState(value as ApprovalState)}
        />
        <Button type="submit" variant="primary">
          Apply filters
        </Button>
      </form>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!approvals && !error && <Skeleton label="Loading approvals…" />}

      {approvals && approvals.length === 0 && appliedState === 'pending' && (
        <EmptyState
          icon={<IconCheck size={24} />}
          title="Nothing waiting on you"
          description="Every approval has been decided. New requests appear here as workflows park on them."
        />
      )}

      {approvals && approvals.length === 0 && appliedState !== 'pending' && (
        <EmptyState
          icon={<IconCheck size={24} />}
          title="No approvals match this filter"
          description="Clear or adjust the state filter above."
        />
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

      {approvals && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}
    </div>
  );
}
