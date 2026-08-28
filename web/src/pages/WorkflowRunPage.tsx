import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  decideApproval,
  getWorkflowRunById,
  listApprovals,
  workflowRunEventsUrl,
  type Approval,
  type ApprovalDecision,
  type WithCount,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '../api/client';
import ApprovalDecisionDialog from '../components/ApprovalDecisionDialog';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { useEventStream } from '../lib/use-event-stream';
import { shortId, workflowTypeLabel } from '../lib/identifiers';
import { useSession } from '../lib/use-session';
import { isTerminalRun } from '../lib/workflow-runs';

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface WorkflowRunPageProps {
  // Overridable so tests can drive the poll cadence.
  pollIntervalMs?: number;
}

const STATUS_TONE: Record<WorkflowRunStatus, 'verified' | 'info' | 'neutral' | 'rejected'> = {
  completed: 'verified',
  running: 'info',
  queued: 'neutral',
  failed: 'rejected',
};

// The stream's `run` and `approvals` events carry different payload shapes; `heartbeat` carries
// none this page reads. `onEvent`/`isTerminal` narrow on `eventName` before touching `data`.
type WorkflowStreamPayload = WorkflowRun | WithCount<Approval>;

function stepClassName(active: boolean, done: boolean): string {
  return ['timeline-step', active && 'is-active', !active && done && 'is-done']
    .filter(Boolean)
    .join(' ');
}

// Renders a step's real timestamp when one is known, or says plainly that none is — never a
// guessed or interpolated time. `resumedAt` in particular is only ever known when this browser
// tab is the one that decided the approval; a run resumed from another tab or by a timeout has no
// timestamp this page can show.
function TimelineWhen({ value }: { value: string | null }) {
  return value ? <Timestamp value={value} /> : <span className="cell-sub">Time not recorded</span>;
}

export default function WorkflowRunPage({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: WorkflowRunPageProps) {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [approvalDocs, setApprovalDocs] = useState<Approval[]>([]);
  // Sticky once set: the approval that paused this run disappears from the approvals list the
  // moment it's decided, but the timeline still needs to say the run *was* paused, not just
  // that no approval is pending right now. `pausedAt` is the pending approval's own `createdAt`,
  // captured the same way for the same reason — it stops existing on the fetched object once
  // the approval is decided.
  const [everPaused, setEverPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState<string | null>(null);
  // Set only from this tab's own decide response (`decideApproval` returns the decided
  // approval's `decidedAt`). A run resumed by a decision made elsewhere, or by the approval's own
  // timeout, never populates this — `listApprovals()` defaults to `state: 'pending'`, so a
  // decided approval never comes back through a poll or the SSE stream for this page to read.
  const [resumedAt, setResumedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const mountedRef = useRef(true);
  // The dialog's own open/decision-direction state, set only from the admin-gated buttons below —
  // `ApprovalDecisionDialog` owns everything past that: the reason input, in-flight state, and
  // error display.
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);
  const session = useSession();
  const canDecide = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  // Set on every mount, not just cleared on unmount: StrictMode's development mount simulation
  // runs setup, cleanup, setup against the same instance, and a ref survives that cycle. Without
  // the assignment the flag is false for the component's whole life, and `refresh` — the only
  // reader — discards every result it fetches.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pendingApproval = useMemo(
    () =>
      run
        ? (approvalDocs.find((approval) => approval.workflowId === run.workflowId) ?? null)
        : null,
    [run, approvalDocs],
  );

  // Adjusts state directly during render rather than in an effect — the sanctioned pattern for
  // "flip a flag the first time a derived value becomes truthy" (react.dev/learn/you-might-not-need-an-effect).
  if (pendingApproval && !everPaused) {
    setEverPaused(true);
    setPausedAt(pendingApproval.createdAt);
  }

  async function handleConfirm(decision: ApprovalDecision, reason: string | undefined) {
    if (!pendingApproval) return;
    const decided = await decideApproval(pendingApproval.id, decision, reason);
    setResumedAt(decided.decidedAt ?? null);
    notify(
      'success',
      decision === 'approved'
        ? 'Approved — the workflow resumes.'
        : 'Rejected — the workflow resumes.',
    );
    // `decide()` (`approvals.service.ts`) only ever accepts a pending approval, so a success
    // response means it has left the pending inbox `listApprovals()` returns — matching
    // ApprovalsPage's own `handleDecided`.
    setApprovalDocs((current) => current.filter((approval) => approval.id !== pendingApproval.id));
    setPendingDecision(null);
  }

  // `isCurrent` returns false once the caller's effect has been torn down, so a response that
  // lands late — after unmount, or after a newer tick moved the run on — is dropped instead of
  // overwriting fresher state.
  const refresh = useCallback(
    (isCurrent: () => boolean) => {
      if (!id) return;
      Promise.all([getWorkflowRunById(id), listApprovals()])
        .then(([runResult, { docs }]) => {
          if (!isCurrent()) return;
          setRun(runResult);
          setApprovalDocs(docs);
          setError(null);
          setNotFound(false);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
            return;
          }
          setError(err instanceof Error ? err.message : 'Failed to load workflow run');
        });
    },
    [id],
  );

  // Refetches the run and its approvals. Fires once, immediately, whenever `useEventStream` gives
  // up on the connection — including at mount in an environment with no `EventSource` at all.
  const handleFallback = useCallback(() => {
    refresh(() => mountedRef.current);
  }, [refresh]);

  const handleStreamEvent = useCallback((eventName: string, data: WorkflowStreamPayload) => {
    if (eventName === 'run') {
      setRun(data as WorkflowRun);
      setError(null);
    } else if (eventName === 'approvals') {
      setApprovalDocs((data as WithCount<Approval>).docs);
    }
  }, []);

  const isStreamEventTerminal = useCallback((eventName: string, data: WorkflowStreamPayload) => {
    if (eventName !== 'run') return false;
    return isTerminalRun((data as WorkflowRun).status);
  }, []);

  const streamState = useEventStream<WorkflowStreamPayload>({
    url: id ? workflowRunEventsUrl(id) : null,
    events: ['run', 'approvals', 'heartbeat'],
    onEvent: handleStreamEvent,
    onFallback: handleFallback,
    isTerminal: isStreamEventTerminal,
  });

  const runStatus = run?.status;

  // Continues the fallback's polling only while the stream stays down and the run is still in
  // flight. Depends on the status value, not the `run` object, so one interval spans every tick
  // that reports the same status and the poll cadence stays fixed rather than drifting by the
  // response latency of each tick.
  useEffect(() => {
    if (streamState !== 'fallback') return;
    if (!runStatus || isTerminalRun(runStatus)) return;
    let cancelled = false;
    const timer = setInterval(() => refresh(() => !cancelled), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [streamState, runStatus, refresh, pollIntervalMs]);

  const isTerminal = !!runStatus && isTerminalRun(runStatus);
  const isPaused = !!pendingApproval;
  const isResumed = everPaused && isTerminal;

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Review</span>
          <h1 className="page-title">Run timeline</h1>
          <p className="page-sub">Watch a run pause for a human decision and resume after it.</p>
        </div>
        <Link to="/workflow-runs" className="btn btn--secondary btn--sm">
          Back to runs
        </Link>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!id && (
        <p className="error error--page" role="alert">
          No workflow run id provided.
        </p>
      )}

      {notFound && <p className="notice notice--info">Workflow run not found.</p>}

      {!run && !error && !notFound && id && <Skeleton label="Loading run timeline…" />}

      {run && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">{workflowTypeLabel(run.workflowType)}</h2>
              <p className="cell-sub mono" title={run.workflowId}>
                {shortId(run.workflowId)}
              </p>
            </div>
            <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
          </div>

          {/* This page refreshes status over a 1.5s SSE stream that falls back to polling, but
              the API's own status read is cached up to 15s and, on an engine failure, falls
              back further to the last durable value — so status here can lag the live run by
              several seconds even while the connection itself reads as live. */}
          <p className="cell-sub">Status refreshes periodically and may lag the live run.</p>

          {run.status === 'failed' && run.errorMessage && (
            <p className="cell-sub">{run.errorMessage}</p>
          )}

          {/* `sync-source` never parks on a human approval (`sync-source.workflow.ts` loops the
              sync activity directly), so it gets a two-step timeline instead of the
              pause/resume shape below. `resolve-conflict` and a run written before the API
              recorded a type both take the pause/resume shape — an untyped run's real workflow
              is unknown, and the approval step only ever lights up when `pendingApproval` is
              actually found, so rendering it for a legacy sync-source row stays inert. */}
          {run.workflowType === 'sync-source' ? (
            <ol className="timeline">
              <li className={stepClassName(!isTerminal, true)}>
                <span className="timeline-step-label">Started</span>
                <Timestamp value={run.createdAt} />
              </li>
              <li className={stepClassName(false, isTerminal)}>
                <span className="timeline-step-label">
                  {isTerminal ? `Finished — ${run.status}` : 'Syncing'}
                </span>
                {/* `WorkflowRun` carries no completion timestamp — only `createdAt` — so a
                    finished sync-source run can say what it ended in but not exactly when. */}
                {isTerminal && <TimelineWhen value={null} />}
                {run.errorMessage && <p className="cell-sub">{run.errorMessage}</p>}
              </li>
            </ol>
          ) : (
            <ol className="timeline">
              <li className={stepClassName(!isPaused && !isTerminal, true)}>
                <span className="timeline-step-label">Started</span>
                <Timestamp value={run.createdAt} />
              </li>

              <li className={stepClassName(isPaused, everPaused)}>
                <span className="timeline-step-label">
                  {isPaused ? 'Paused — awaiting approval' : 'Awaiting approval'}
                </span>
                {everPaused && <TimelineWhen value={pausedAt} />}
                {pendingApproval && (
                  <div className="notice notice--info">
                    <p>{pendingApproval.summary}</p>
                    {pendingApproval.requestedBy && (
                      <p className="cell-sub">Requested by {pendingApproval.requestedBy}</p>
                    )}
                    {/* `decide()` (`approvals.service.ts`) rejects a non-pending approval outright
                        — `listApprovals()` above already filters to `pending` server-side, but this
                        stays explicit so a future SSE `approvals` push carrying a decided approval
                        can never surface controls that would only 409. */}
                    {pendingApproval.state === 'pending' && (
                      <div className="form-actions">
                        {canDecide && (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => setPendingDecision('approved')}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setPendingDecision('rejected')}
                            >
                              Reject
                            </Button>
                          </>
                        )}
                        {sessionResolved && !canDecide && (
                          <p className="cell-sub">Deciding approvals requires an admin.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>

              <li className={stepClassName(false, isResumed)}>
                <span className="timeline-step-label">
                  {isTerminal ? `Resumed — ${run.status}` : 'Not yet resumed'}
                </span>
                {isTerminal && <TimelineWhen value={resumedAt} />}
                {run.errorMessage && <p className="cell-sub">{run.errorMessage}</p>}
              </li>
            </ol>
          )}

          <ApprovalDecisionDialog
            decision={pendingDecision}
            summary={pendingApproval?.summary ?? ''}
            resumesWorkflow
            onClose={() => setPendingDecision(null)}
            onConfirm={handleConfirm}
          />
        </section>
      )}
    </div>
  );
}
