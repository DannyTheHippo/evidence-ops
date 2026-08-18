import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getWorkflowRunById,
  listApprovals,
  workflowRunEventsUrl,
  type Approval,
  type WithCount,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { useEventStream } from '../lib/use-event-stream';

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

export default function WorkflowRunPage({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: WorkflowRunPageProps) {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [approvalDocs, setApprovalDocs] = useState<Approval[]>([]);
  // Sticky once set: the approval that paused this run disappears from the approvals list the
  // moment it's decided, but the timeline still needs to say the run *was* paused, not just
  // that no approval is pending right now.
  const [everPaused, setEverPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

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
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
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
    const status = (data as WorkflowRun).status;
    return status === 'completed' || status === 'failed';
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
    if (!runStatus || runStatus === 'completed' || runStatus === 'failed') return;
    let cancelled = false;
    const timer = setInterval(() => refresh(() => !cancelled), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [streamState, runStatus, refresh, pollIntervalMs]);

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

      {!run && !error && id && <Skeleton label="Loading…" />}

      {run && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title mono">{run.workflowId}</h2>
            <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
          </div>

          {run.status === 'failed' && run.errorMessage && (
            <p className="cell-sub">{run.errorMessage}</p>
          )}

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
