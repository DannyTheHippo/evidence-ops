import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getWorkflowRunById, listApprovals, type Approval, type WorkflowRun } from '../api/client';

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface WorkflowRunPageProps {
  // Overridable so tests can drive the poll cadence.
  pollIntervalMs?: number;
}

function statusBadgeClass(status: WorkflowRun['status']): string {
  if (status === 'completed') return 'badge badge--strong';
  if (status === 'failed') return 'badge badge--failed';
  return 'badge badge--neutral';
}

function stepClassName(active: boolean, done: boolean): string {
  return ['timeline-step', active && 'is-active', !active && done && 'is-done']
    .filter(Boolean)
    .join(' ');
}

export default function WorkflowRunPage({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: WorkflowRunPageProps) {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [pendingApproval, setPendingApproval] = useState<Approval | null>(null);
  // Sticky once set: the approval that paused this run disappears from GET /approvals the
  // moment it's decided, but the timeline still needs to say the run *was* paused, not just
  // that no approval is pending right now.
  const [everPaused, setEverPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          const matched = docs.find((approval) => approval.workflowId === runResult.workflowId);
          setPendingApproval(matched ?? null);
          if (matched) setEverPaused(true);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setError(err instanceof Error ? err.message : 'Failed to load workflow run');
        });
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    refresh(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const runStatus = run?.status;

  // Polls while the run is in flight. Depends on the status value, not the `run` object, so one
  // interval spans every tick that reports the same status and the poll cadence stays fixed
  // rather than drifting by the response latency of each tick.
  useEffect(() => {
    if (!runStatus || runStatus === 'completed' || runStatus === 'failed') return;
    let cancelled = false;
    const timer = setInterval(() => refresh(() => !cancelled), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runStatus, refresh, pollIntervalMs]);

  const isTerminal = runStatus === 'completed' || runStatus === 'failed';
  const isPaused = !!pendingApproval;
  const isResumed = everPaused && isTerminal;

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Workflow</span>
          <h1 className="page-title">Run timeline</h1>
          <p className="page-sub">Watch a run pause for a human decision and resume after it.</p>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!id && (
        <p className="error" role="alert">
          No workflow run id provided.
        </p>
      )}

      {!run && !error && id && <p>Loading…</p>}

      {run && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title mono">{run.workflowId}</h2>
            <span className={statusBadgeClass(run.status)}>
              {!isTerminal && <span className="badge-dot" />}
              {run.status}
            </span>
          </div>

          <ol className="timeline">
            <li className={stepClassName(!isPaused && !isTerminal, true)}>
              <span className="timeline-step-label">Started</span>
              <span className="cell-sub">{new Date(run.createdAt).toLocaleString()}</span>
            </li>

            <li className={stepClassName(isPaused, everPaused)}>
              <span className="timeline-step-label">
                {isPaused ? 'Paused — awaiting approval' : 'Awaiting approval'}
              </span>
              {pendingApproval && (
                <div className="notice notice--info">
                  <p>{pendingApproval.summary}</p>
                  {pendingApproval.requestedBy && (
                    <p className="cell-sub">Requested by {pendingApproval.requestedBy}</p>
                  )}
                </div>
              )}
            </li>

            <li className={stepClassName(false, isResumed)}>
              <span className="timeline-step-label">
                {isTerminal ? `Resumed — ${run.status}` : 'Not yet resumed'}
              </span>
              {run.errorMessage && <p className="cell-sub">{run.errorMessage}</p>}
            </li>
          </ol>
        </section>
      )}
    </div>
  );
}
