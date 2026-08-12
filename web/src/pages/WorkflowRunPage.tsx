import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getWorkflowRunById, listApprovals, type Approval, type WorkflowRun } from '../api/client';

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface WorkflowRunPageProps {
  // Overridable so tests can poll on a short interval instead of stubbing timers.
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

  const refresh = useCallback(() => {
    if (!id) return;
    Promise.all([getWorkflowRunById(id), listApprovals()])
      .then(([runResult, { docs }]) => {
        setRun(runResult);
        const matched = docs.find((approval) => approval.workflowId === runResult.workflowId);
        setPendingApproval(matched ?? null);
        if (matched) setEverPaused(true);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load workflow run');
      });
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Polls while the run is in flight, matching AskPage's approach: depend on the status value,
  // not the whole `run` object, so the interval survives ticks that don't change status.
  useEffect(() => {
    if (!run || run.status === 'completed' || run.status === 'failed') return;
    const timer = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(timer);
  }, [run, refresh, pollIntervalMs]);

  const isTerminal = run?.status === 'completed' || run?.status === 'failed';
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
                {isTerminal ? `Resumed — ${run.status}` : 'Resumed'}
              </span>
              {run.errorMessage && <p className="cell-sub">{run.errorMessage}</p>}
            </li>
          </ol>
        </section>
      )}
    </div>
  );
}
