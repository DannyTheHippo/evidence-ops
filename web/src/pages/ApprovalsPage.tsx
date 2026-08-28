import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  decideApproval,
  listApprovals,
  listConflicts,
  listWorkflowRuns,
  type Approval,
  type ApprovalDecision,
  type ApprovalSortField,
  type ApprovalState,
  type Conflict,
  type SortDirection,
} from '../api/client';
import ApprovalDecisionDialog from '../components/ApprovalDecisionDialog';
import { IconCheck } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import FilterBar from '../components/ui/FilterBar';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import SplitView from '../components/ui/SplitView';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { shortId } from '../lib/identifiers';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 20;

// No "All states" entry — the server substitutes `pending` when the param is omitted
// (`approvals.service.ts`'s `peekPending`), so omitting the filter never means "every state".
const STATE_OPTIONS: { value: ApprovalState; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'timed_out', label: 'Timed out' },
];

const SORT_OPTIONS: { value: ApprovalSortField; label: string }[] = [
  { value: 'createdAt', label: 'Requested' },
  { value: 'state', label: 'State' },
  { value: 'decidedAt', label: 'Decided' },
];

const DIRECTION_OPTIONS: { value: SortDirection; label: string }[] = [
  { value: 'desc', label: 'Descending' },
  { value: 'asc', label: 'Ascending' },
];

const stateTone: Record<ApprovalState, 'caution' | 'verified' | 'rejected' | 'neutral'> = {
  pending: 'caution',
  approved: 'verified',
  rejected: 'rejected',
  timed_out: 'neutral',
};

// Declared at module scope, matching AnswersPage.tsx's own `URL_DEFAULTS` — `useUrlState` adopts
// this once on mount and keeps that identity for the hook's lifetime.
const URL_DEFAULTS: Record<'state' | 'sort' | 'sortDir' | 'skip', string> = {
  state: 'pending',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

/** The value `conflict.proposedWinnerFactId` points at, formatted for display — undefined when
 *  the id names no value in `conflict.values` (data drift) or the policy proposed none. */
function conflictWinnerLabel(conflict: Conflict): string | undefined {
  const winner = conflict.values.find((value) => value.factId === conflict.proposedWinnerFactId);
  return winner ? `${winner.value} ${winner.unit}` : undefined;
}

function ApprovalDetail({
  approval,
  canDecide,
  sessionResolved,
  conflict,
  metricLabels,
  onDecided,
}: {
  approval: Approval;
  canDecide: boolean;
  sessionResolved: boolean;
  conflict?: Conflict;
  metricLabels: Record<string, string>;
  onDecided: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);
  const [viewingRun, setViewingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const winnerLabel = conflict ? conflictWinnerLabel(conflict) : undefined;

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
    await decideApproval(approval.id, decision, reason);
    notify(
      'success',
      decision === 'approved'
        ? 'Approved — the workflow resumes.'
        : 'Rejected — the workflow resumes.',
    );
    setPendingDecision(null);
    onDecided(approval.id);
  }

  return (
    <div className="card">
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
      <p className="cell-sub">
        Requested <Timestamp value={approval.createdAt} />
      </p>
      {approval.state !== 'pending' && approval.decidedAt && (
        <p className="cell-sub">
          Decided <Timestamp value={approval.decidedAt} />
          {approval.decidedBy ? ` by ${approval.decidedBy}` : ''}
        </p>
      )}
      {approval.decisionReason && <p className="cell-sub">Reason: {approval.decisionReason}</p>}

      {conflict && (
        <>
          <p className="cell-sub">
            {conflict.factKey.entity} · {metricLabel(conflict.factKey.metric, metricLabels)} ·{' '}
            {conflict.factKey.period}
          </p>
          {conflict.ruleFired === 'none' ? (
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
          )}
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

      {runError && (
        <p className="error" role="alert">
          {runError}
        </p>
      )}

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

export default function ApprovalsPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedState = urlState.state as ApprovalState;
  const sort = urlState.sort as ApprovalSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  // Only this, not the state Select's own value, drives the fetch — the filter applies on
  // submit, not on every selection change (AnswersPage.tsx follows the same split).
  const [draftState, setDraftState] = useState(appliedState);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [conflictsById, setConflictsById] = useState<Map<string, Conflict>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = useSession();
  const metricLabels = useMetricLabels();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the decide controls flash in before the check lands.
  const canDecide = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useEffect(() => {
    let cancelled = false;

    listApprovals({ skip, limit: PAGE_SIZE, state: appliedState, sort, sortDir })
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
  }, [skip, appliedState, sort, sortDir]);

  // A conflict-resolution approval carries no proposal of its own — `subject.entityId` is the
  // conflict id, and the proposal (winner, rule, explanation) lives on the conflict. Bounded to
  // the number of Conflict-subject approvals actually rendered this page, never to the tenant's
  // whole conflict set: `/conflicts` has no id filter, so a referenced conflict outside this
  // recency-sorted window still goes unannotated — the row renders without the recommendation
  // rather than blocking the page (see the `.catch(() => {})` below).
  useEffect(() => {
    const subjectCount =
      approvals?.filter((approval) => approval.subject.entityType === 'Conflict').length ?? 0;
    if (subjectCount === 0) return;
    let cancelled = false;

    listConflicts({ limit: subjectCount })
      .then(({ docs }) => {
        if (!cancelled) setConflictsById(new Map(docs.map((conflict) => [conflict.id, conflict])));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [approvals]);

  function handleApplyFilter() {
    setUrlState({ state: draftState, skip: URL_DEFAULTS.skip });
  }

  function handleClearFilter() {
    setDraftState(URL_DEFAULTS.state as ApprovalState);
    setUrlState({ state: URL_DEFAULTS.state, skip: URL_DEFAULTS.skip });
  }

  // A decided approval leaves the pending inbox — decide controls only render on a pending-state
  // row (`decide()` in `approvals.service.ts` rejects anything else), so removing it locally on
  // success matches what a re-fetch of the pending filter would show anyway.
  function handleDecided(id: string) {
    setApprovals((current) => current?.filter((approval) => approval.id !== id) ?? current);
    setCount((current) => Math.max(0, current - 1));
  }

  const hasFilter = appliedState !== URL_DEFAULTS.state;
  // Falls back to the first row once the previous selection leaves the current page (paging,
  // filtering, or its own decision) — a render-time derivation rather than an effect syncing
  // selection to a prop/state change.
  const selectedApproval =
    approvals?.find((approval) => approval.id === selectedId) ?? approvals?.[0] ?? null;
  const selectedConflict =
    selectedApproval?.subject.entityType === 'Conflict'
      ? conflictsById.get(selectedApproval.subject.entityId)
      : undefined;

  let status: RecordListStatus;
  if (approvals === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading approvals…' };
  } else if (approvals.length === 0) {
    status =
      appliedState === 'pending'
        ? {
            kind: 'empty',
            icon: <IconCheck size={24} />,
            title: 'Nothing waiting on you',
            description:
              'Every approval has been decided. New requests appear here as workflows park on them.',
          }
        : {
            kind: 'empty',
            icon: <IconCheck size={24} />,
            title: 'No approvals match this filter',
            description: 'Clear or adjust the state filter above.',
          };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Review"
      title="Approvals"
      description="Pending human decisions gating a workflow run."
      filters={
        <>
          <FilterBar onApply={handleApplyFilter} onClear={handleClearFilter} hasFilter={hasFilter}>
            <Select
              label="State"
              options={STATE_OPTIONS}
              value={draftState}
              onChange={(value) => setDraftState(value as ApprovalState)}
            />
          </FilterBar>
          <div className="control-row">
            <div className="sort-select">
              <Select
                label="Sort by"
                options={SORT_OPTIONS}
                value={sort}
                onChange={(value) => setUrlState({ sort: value, skip: URL_DEFAULTS.skip })}
              />
            </div>
            <div className="sort-select">
              <Select
                label="Direction"
                options={DIRECTION_OPTIONS}
                value={sortDir}
                onChange={(value) => setUrlState({ sortDir: value, skip: URL_DEFAULTS.skip })}
              />
            </div>
          </div>
        </>
      }
      error={error ?? undefined}
      status={status}
      footer={
        approvals && (
          <Pager
            count={count}
            skip={skip}
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {approvals && approvals.length > 0 && (
        <SplitView
          ratio="queue"
          primaryLabel="Approvals queue"
          secondaryLabel="Approval details"
          primary={
            <ul className="approval-list" aria-label="Approvals awaiting review">
              {approvals.map((approval) => {
                const isSelected = approval.id === selectedApproval?.id;
                return (
                  <li key={approval.id}>
                    <button
                      type="button"
                      className={`card queue-item${isSelected ? ' is-active' : ''}`}
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => setSelectedId(approval.id)}
                    >
                      <div className="card-head">
                        <h2 className="card-title cell-truncate">{approval.summary}</h2>
                        <Badge tone={stateTone[approval.state]}>{approval.state}</Badge>
                      </div>
                      <p className="cell-sub">
                        Requested <Timestamp value={approval.createdAt} />
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          }
          secondary={
            selectedApproval ? (
              <ApprovalDetail
                approval={selectedApproval}
                canDecide={canDecide}
                sessionResolved={sessionResolved}
                conflict={selectedConflict}
                metricLabels={metricLabels}
                onDecided={handleDecided}
              />
            ) : null
          }
        />
      )}
    </RecordListPage>
  );
}
