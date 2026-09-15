import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApiError,
  decideApproval,
  getWorkflowRunById,
  listApprovals,
  lookupDocumentVersions,
  workflowRunEventsUrl,
  type Approval,
  type ApprovalDecision,
  type WithCount,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunType,
} from '../api/client';
import ApprovalDecisionDialog from '../components/ApprovalDecisionDialog';
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import CopyButton from '../components/ui/CopyButton';
import EmptyState from '../components/ui/EmptyState';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Skeleton from '../components/ui/Skeleton';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import { notify } from '../components/ui/toast';
import { announce } from '../lib/announce';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { CONNECTION_LABELS, useEventStream, type StreamState } from '../lib/use-event-stream';
import { shortId, workflowTypeLabel } from '../lib/identifiers';
import {
  approvalStateForOutcome,
  runStatusView,
  runTypeCanPark,
  runWorkStepLabel,
  type WorkflowRunOutcome,
} from '../lib/run-status';
import { useAbortableEffect, useLatest } from '../lib/use-latest';
import { invalidatePendingCounts } from '../lib/use-pending-counts';
import { useSession } from '../lib/use-session';
import { isTerminalRun } from '../lib/workflow-runs';

const DEFAULT_POLL_INTERVAL_MS = 1500;

// Streaming states in which the connection itself is recovering — a run watched during any of
// these can least afford to also stop polling, so the fallback interval below runs through all
// three rather than only the terminal `fallback` state. `use-answer-run.ts`'s own
// `POLLING_STREAM_STATES` is module-private, so this is declared again rather than imported.
const POLLING_STREAM_STATES: readonly StreamState[] = ['stale', 'reconnecting', 'fallback'];

interface WorkflowRunPageProps {
  // Overridable so tests can drive the poll cadence.
  pollIntervalMs?: number;
}

// The stream's `run` and `approvals` events carry different payload shapes; `heartbeat` carries
// none this page reads. `onEvent`/`isTerminal` narrow on `eventName` before touching `data`.
type WorkflowStreamPayload = WorkflowRun | WithCount<Approval>;

// The rail marker states a step can carry: idle (unreached, hollow), active (in motion, pulsing),
// done (reached, settled, affirmative), declined (reached, settled, not affirmative — a refusal or
// a timeout), rejected (reached and failed). Never more than one step reads `active` at once, and
// none does once the whole run is terminal — the pulse is a claim about something still moving,
// not a decoration a finished run keeps wearing.
type RunStepState = 'idle' | 'active' | 'done' | 'declined' | 'rejected';

function runStepClassName(state: RunStepState): string {
  return state === 'idle' ? 'run-step' : `run-step run-step--${state}`;
}

// A step's marker and colour alone never carried its state to a screen reader. Every state but
// idle (an unreached step needs no prefix — the label itself never claims to be current) gets a
// `.sr-only` prefix spoken ahead of the visible label. Rendered as a sibling of the visible label,
// never nested inside it, so a query for the plain label text keeps matching exactly one element.
const RUN_STEP_PREFIXES: Partial<Record<RunStepState, string>> = {
  active: 'In progress: ',
  done: 'Completed: ',
  declined: 'Not completed: ',
  rejected: 'Failed: ',
};

function RunStepLabel({ state, label }: { state: RunStepState; label: string }) {
  const prefix = RUN_STEP_PREFIXES[state];
  return (
    <>
      {prefix && <span className="sr-only">{prefix}</span>}
      <span className="timeline-step-label">{label}</span>
    </>
  );
}

// The first step whose state is idle or active is the run's current step — and only while the run
// is still moving: neither terminal nor stale (the engine has lost the workflow, so nothing here
// will move again either). A settled run carries no current step, even one that landed idle (an
// approval never reached, say): the run is no longer moving toward it. Returns -1 when nothing
// qualifies.
function currentStepIndex(states: readonly RunStepState[], isSettled: boolean): number {
  if (isSettled) return -1;
  return states.findIndex((state) => state === 'idle' || state === 'active');
}

interface StepView {
  state: RunStepState;
  // `undefined` renders no time row at all — the label already says everything this step has to
  // say. `null` renders "Time not recorded": the step has a time slot, but nothing populated it.
  time?: string | null;
  label: string;
  decidedBy?: string;
}

// The three-step shape's approval step (`resolve-conflict`, `ingest-document-version`, and a run
// written before the API recorded a type). First matching row wins.
function approvalStepView(params: {
  isTerminal: boolean;
  // True while the run is stale (engine lost track of it, status frozen non-terminal) — a step
  // this page can no longer say is paused, decided, or unreached, since nothing further will ever
  // arrive to say which.
  isStale?: boolean;
  isPaused: boolean;
  everPaused: boolean;
  pausedAt: string | null;
  resumedAt: string | null;
  status: WorkflowRunStatus;
  outcome?: WorkflowRunOutcome;
  workflowType?: WorkflowRunType;
  decidedApproval: Approval | null;
}): StepView {
  const {
    isTerminal,
    isStale,
    isPaused,
    everPaused,
    pausedAt,
    resumedAt,
    status,
    outcome,
    workflowType,
    decidedApproval,
  } = params;
  if (!isTerminal) {
    if (isStale) return { state: 'idle', label: 'Status unknown' };
    if (isPaused) return { state: 'active', label: 'Paused — awaiting approval', time: pausedAt };
    if (everPaused) return { state: 'done', label: 'Approval decided', time: resumedAt };
    return { state: 'idle', label: 'Awaiting approval' };
  }
  if (outcome === 'resolved') {
    return {
      state: 'done',
      label: 'Approval granted',
      time: decidedApproval?.decidedAt ?? null,
      decidedBy: decidedApproval?.decidedBy,
    };
  }
  if (outcome === 'rejected') {
    return {
      state: 'declined',
      label: 'Approval refused',
      time: decidedApproval?.decidedAt ?? null,
      decidedBy: decidedApproval?.decidedBy,
    };
  }
  if (outcome === 'timed_out') {
    return {
      state: 'declined',
      // Deliberately distinct from the final step's own `Approval timed out` — two identical
      // labels in one list break `getByText`.
      label: 'Approval expired',
      time: decidedApproval?.decidedAt ?? null,
      decidedBy: decidedApproval?.decidedBy,
    };
  }
  if (everPaused) return { state: 'done', label: 'Approval decided', time: resumedAt };
  if (status === 'failed') return { state: 'idle', label: 'Approval not reached' };
  // `ingest-document-version` only requests an approval when `requireApproval` is set — inferring
  // one here for every completed ingest would be a false claim the same way the row below would be
  // for one of these runs.
  if (workflowType === 'ingest-document-version') {
    return { state: 'idle', label: 'No approval requested' };
  }
  // A `resolve-conflict` workflow always requests approval, so a completed one this tab never
  // watched pause was still decided — it just has no timestamp this page can recover.
  return { state: 'done', label: 'Approval decided — time not recorded' };
}

// The three-step shape's final step. `status === 'failed'` outranks `outcome` — `recordEnd` only
// overwrites `outcome` on a terminal write that actually carries one, so a run that fails after an
// earlier write already set `outcome` would otherwise show that earlier value instead of the
// failure.
function finalStepView(params: {
  isTerminal: boolean;
  isStale?: boolean;
  status: WorkflowRunStatus;
  outcome?: WorkflowRunOutcome;
  resumedAt: string | null;
  decidedApproval: Approval | null;
}): StepView {
  const { isTerminal, isStale, status, outcome, resumedAt, decidedApproval } = params;
  if (!isTerminal) return { state: 'idle', label: isStale ? 'Status unknown' : 'Not yet resumed' };
  const time = resumedAt ?? decidedApproval?.decidedAt ?? null;
  if (status === 'failed') return { state: 'rejected', label: 'Failed', time };
  if (outcome === 'resolved') return { state: 'done', label: 'Resolved', time };
  if (outcome === 'rejected') return { state: 'declined', label: 'Rejected', time };
  if (outcome === 'timed_out') return { state: 'declined', label: 'Approval timed out', time };
  return { state: 'done', label: 'Finished', time };
}

// The two-step shape's second step, for a type that never parks on an approval. `WorkflowRun`
// carries no completion timestamp, so a terminal work step always reads "Time not recorded".
function workStepView(params: {
  isTerminal: boolean;
  isStale?: boolean;
  status: WorkflowRunStatus;
  workflowType?: WorkflowRunType;
}): StepView {
  const { isTerminal, isStale, status, workflowType } = params;
  if (!isTerminal) {
    return isStale
      ? { state: 'idle', label: 'Status unknown' }
      : { state: 'active', label: runWorkStepLabel(workflowType) };
  }
  if (status === 'failed') return { state: 'rejected', label: 'Failed', time: null };
  return { state: 'done', label: 'Finished', time: null };
}

// Header copy by run type — a single sentence across every type would be false for a type that
// never pauses on an approval, so each type gets a description of what this page actually watches
// for it.
const HEADER_DESCRIPTIONS: Partial<Record<WorkflowRunType, string>> = {
  'resolve-conflict': 'Watch a run pause for a human decision and resume after it.',
  'sync-source': 'Watch a source sync run to completion.',
  'answer-question': 'Watch a question run to an answer.',
  'ingest-document-version': 'Watch a document version ingest, including any approval it waits on.',
};

function headerDescription(workflowType?: WorkflowRunType): string {
  return (workflowType && HEADER_DESCRIPTIONS[workflowType]) || "Watch this run's progress.";
}

interface SubjectLink {
  to: string;
  label: string;
}

// `subjectType` is a free string the DTO cannot narrow, and every run type writes the pair — an
// ingest or question run's subject is not a conflict, so the target and label both come from this
// table rather than a single hard-coded conflict route. `DocumentVersion`
// is handled separately below: its target needs the owning document id, which the run itself
// doesn't carry.
const SUBJECT_LINK_BUILDERS: Record<string, (subjectId: string) => SubjectLink> = {
  Conflict: (subjectId) => ({
    to: `/adjudication?kind=conflicts&selected=${subjectId}`,
    label: 'View conflict',
  }),
  Source: (subjectId) => ({ to: `/sources/${subjectId}`, label: 'View source' }),
  Answer: (subjectId) => ({ to: `/answers/${subjectId}`, label: 'View answer' }),
};

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
  // False until the first pending-approval list arrives, from a fetch or the stream — `approvalDocs`
  // alone cannot tell "not loaded yet" apart from "loaded, and nothing is pending".
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);
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
  // True while `handleConfirm` awaits `decideApproval`. State rather than a ref, because the
  // render-time stale close below reads it.
  const [decisionInFlight, setDecisionInFlight] = useState(false);
  // The pending-approval fetch above only ever returns a `pending` row, so a resolve-conflict run
  // opened after it already finished never populates `resumedAt` through this tab's own polling —
  // this fetches the same run's decided approval directly, by the state its own outcome implies.
  const [decidedApproval, setDecidedApproval] = useState<Approval | null>(null);
  const [documentVersionLink, setDocumentVersionLink] = useState<{
    versionId: string;
    documentId: string;
  } | null>(null);
  // Survives the approval action card's unmount, unlike a ref on anything inside it — the target
  // for focus after a decision resolves.
  const approvalStepRef = useRef<HTMLLIElement | null>(null);
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

  useBreadcrumbs([
    { label: 'Runs', to: '/workflow-runs' },
    { label: run ? `${workflowTypeLabel(run.workflowType)} ${shortId(run.workflowId)}` : 'Run' },
  ]);

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

  // Same render-time adjustment, for a dialog that was open when the run turned stale: the engine
  // has lost the workflow, so a decision this tab records now could never reach it. This close
  // skips a dialog whose submit is in flight — its result still has to reach the user, and
  // `handleConfirm` closes the dialog itself once that submit settles.
  if (run?.stale && pendingDecision && !decisionInFlight) {
    setPendingDecision(null);
  }

  // The approval an open decision dialog is deciding, or null when no dialog is open. Read by
  // `applyApprovalDocs` below, which runs outside render and so cannot read the state directly.
  const decidingApprovalRef = useLatest(pendingDecision ? pendingApproval : null);
  // Whether the run is stale as of the latest commit, for `handleConfirm` to read once its await
  // settles — the `run` its own closure captured is the one from the render that submitted.
  const isStaleRef = useLatest(!!run?.stale);

  // Applies a freshly arrived pending-approval list, and closes an open decision dialog whose
  // approval is no longer in it — a second admin decided that approval, or it timed out, and the
  // dialog would otherwise sit open over an approval that no longer exists to decide. Once this
  // tab's own decide response lands, `handleConfirm` retires the dialog's approval, so a tick
  // after that raises no toast. A tick that lands while the submit is still in flight, after the
  // server has recorded the decision, still closes the dialog and raises the toast.
  const applyApprovalDocs = useCallback(
    (docs: Approval[]) => {
      setApprovalDocs(docs);
      setApprovalsLoaded(true);
      const deciding = decidingApprovalRef.current;
      if (!deciding || docs.some((approval) => approval.workflowId === deciding.workflowId)) return;
      setPendingDecision(null);
      notify('error', 'This approval was already decided.');
    },
    [decidingApprovalRef],
  );

  async function handleConfirm(decision: ApprovalDecision, reason: string | undefined) {
    if (!pendingApproval) return;
    setDecisionInFlight(true);
    let decided: Approval;
    try {
      decided = await decideApproval(pendingApproval.id, decision, reason);
    } catch (err) {
      // A live run rethrows, so the dialog renders the error inline and stays open to retry. A run
      // that turned stale while this submit was in flight gets a toast and a closed dialog
      // instead: the dialog has nothing left to retry against a workflow the engine no longer
      // has, and a toast is the one surface that outlives its close.
      if (!isStaleRef.current) throw err;
      setPendingDecision(null);
      notify('error', err instanceof Error ? err.message : 'The decision could not be recorded.');
      return;
    } finally {
      setDecisionInFlight(false);
    }
    const settledOnStaleRun = isStaleRef.current;
    // Retires the dialog's approval before the state below commits: a poll or stream tick landing
    // in that window carries a list this approval has already left, and would otherwise read this
    // tab's own decision as someone else's and raise the "already decided" error over the success.
    decidingApprovalRef.current = null;
    setResumedAt(decided.decidedAt ?? null);
    // A stale run's record will not change further, so its success names only what the server
    // confirmed — that the decision was recorded — never that the workflow resumes.
    if (settledOnStaleRun) {
      notify(
        'success',
        decision === 'approved' ? 'Approved — decision recorded.' : 'Rejected — decision recorded.',
      );
      announce('Approval recorded.');
    } else {
      notify(
        'success',
        decision === 'approved'
          ? 'Approved — the workflow resumes.'
          : 'Rejected — the workflow resumes.',
      );
      announce('Approval recorded — the workflow resumes.');
    }
    // `decide()` (`approvals.service.ts`) only ever accepts a pending approval, so a success
    // response means it has left the pending inbox `listApprovals()` returns.
    setApprovalDocs((current) => current.filter((approval) => approval.id !== pendingApproval.id));
    setPendingDecision(null);
    invalidatePendingCounts();
    // The action card this button lives in unmounts the moment `pendingApproval` clears above, so
    // a synchronous focus() here would target an element already gone; the rAF runs after that
    // unmount and after `ApprovalDecisionDialog`'s own close cleanup settles.
    requestAnimationFrame(() => approvalStepRef.current?.focus());
  }

  // `isCurrent` returns false once the caller's effect has been torn down, so a response that
  // lands late — after unmount, or after a newer tick moved the run on — is dropped instead of
  // overwriting fresher state. The run is awaited first, never in parallel with the approvals
  // read: the approvals fetch needs the run's own `workflowId` to stay scoped to this run, and a
  // type that never parks on an approval (`runTypeCanPark`) skips that fetch entirely.
  const refresh = useCallback(
    (isCurrent: () => boolean) => {
      if (!id) return;
      getWorkflowRunById(id)
        .then((runResult) => {
          if (!isCurrent()) return;
          setRun(runResult);
          setError(null);
          setNotFound(false);
          if (!runTypeCanPark(runResult.workflowType)) {
            applyApprovalDocs([]);
            return;
          }
          return listApprovals({
            workflowId: runResult.workflowId,
            state: 'pending',
            limit: 1,
          }).then(({ docs }) => {
            if (!isCurrent()) return;
            applyApprovalDocs(docs);
          });
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
    [id, applyApprovalDocs],
  );

  // Refetches the run and its approvals. Fires once, immediately, whenever `useEventStream` gives
  // up on the connection — including at mount in an environment with no `EventSource` at all.
  const handleFallback = useCallback(() => {
    refresh(() => mountedRef.current);
  }, [refresh]);

  const handleStreamEvent = useCallback(
    (eventName: string, data: WorkflowStreamPayload) => {
      if (eventName === 'run') {
        setRun(data as WorkflowRun);
        setError(null);
      } else if (eventName === 'approvals') {
        applyApprovalDocs((data as WithCount<Approval>).docs);
      }
    },
    [applyApprovalDocs],
  );

  // A `stale` run (the engine has lost this workflow) is settled the same way a terminal status
  // is: nothing further will ever arrive for it, so the stream closes rather than sitting open or
  // reopening on a row that will never change again.
  const isStreamEventTerminal = useCallback((eventName: string, data: WorkflowStreamPayload) => {
    if (eventName !== 'run') return false;
    const runData = data as WorkflowRun;
    return isTerminalRun(runData.status) || runData.stale === true;
  }, []);

  const streamState = useEventStream<WorkflowStreamPayload>({
    url: id && !run?.stale ? workflowRunEventsUrl(id) : null,
    events: ['run', 'approvals', 'heartbeat'],
    onEvent: handleStreamEvent,
    onFallback: handleFallback,
    isTerminal: isStreamEventTerminal,
  });

  const runStatus = run?.status;

  // Continues polling while the stream is anywhere in its own recovery — `stale`, `reconnecting`
  // or fully `fallback` — and the run has not been confirmed terminal. Runs even before the first
  // fetch has ever landed (`!runStatus`), so a first fetch that fails still gets retried instead
  // of leaving the page stuck with no run and no further attempt. Depends on the status value,
  // not the `run` object, so one interval spans every tick that reports the same status and the
  // poll cadence stays fixed rather than drifting by the response latency of each tick.
  useEffect(() => {
    if (!POLLING_STREAM_STATES.includes(streamState)) return;
    if (runStatus && isTerminalRun(runStatus)) return;
    // A stale run is settled the same way — the engine has lost it, so nothing further this
    // interval could fetch would ever move it off its last recorded status.
    if (run?.stale) return;
    let cancelled = false;
    const timer = setInterval(() => refresh(() => !cancelled), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [streamState, runStatus, run?.stale, refresh, pollIntervalMs]);

  const isTerminal = !!runStatus && isTerminalRun(runStatus);
  // True when the stored status is non-terminal and the workflow engine reported it unknown to
  // them — the row is orphaned and `status` will never advance past its last recorded value.
  const isStale = !!run?.stale;
  const isPaused = !!pendingApproval;
  const isFailed = runStatus === 'failed';

  // Fetches the decided approval for a terminal run carrying an outcome, by the state that
  // outcome implies — the only way to recover who decided it or when for a run this tab never
  // watched pause. Fails open: a rejected or empty fetch leaves this null and the approval step
  // still renders, just without a decided time, since this is a display enrichment rather than
  // something the timeline depends on.
  useAbortableEffect(
    (isCurrent) => {
      if (!run || !run.outcome || !isTerminalRun(run.status)) {
        setDecidedApproval(null);
        return;
      }
      listApprovals({
        workflowId: run.workflowId,
        state: approvalStateForOutcome(run.outcome),
        limit: 1,
      })
        .then(({ docs }) => {
          if (!isCurrent()) return;
          setDecidedApproval(docs[0] ?? null);
        })
        .catch(() => {
          if (!isCurrent()) return;
          setDecidedApproval(null);
        });
    },
    [run?.workflowId, run?.status, run?.outcome],
  );

  // `DocumentVersion` is the one subject type whose link needs a join the run itself can't
  // supply — `subjectId` is the version id, and the page it names is keyed by the owning
  // document. Fails open: an unresolved lookup leaves this null and the subject link renders
  // nothing rather than a guessed target.
  useAbortableEffect(
    (isCurrent) => {
      setDocumentVersionLink(null);
      if (run?.subjectType !== 'DocumentVersion' || !run.subjectId) return;
      const versionId = run.subjectId;
      lookupDocumentVersions([versionId])
        .then(({ docs }) => {
          if (!isCurrent()) return;
          const doc = docs[0];
          if (doc) setDocumentVersionLink({ versionId, documentId: doc.documentId });
        })
        .catch(() => {
          // Fails open: no link rather than a guessed target.
        });
    },
    [run?.subjectId, run?.subjectType],
  );

  const subjectLink: SubjectLink | null =
    !run?.subjectId || !run.subjectType
      ? null
      : run.subjectType === 'DocumentVersion'
        ? documentVersionLink?.versionId === run.subjectId
          ? {
              to: `/documents/${documentVersionLink.documentId}/versions/${run.subjectId}`,
              label: 'View document version',
            }
          : null
        : (SUBJECT_LINK_BUILDERS[run.subjectType]?.(run.subjectId) ?? null);

  // Announces a run's terminal transition once — never on open, only on a status change actually
  // observed during this mount. Seeded from the first status this mount loads, so opening an
  // already-terminal run announces nothing; its state is conveyed by the shell's own page-title
  // announcement instead.
  const lastAnnouncedStatusRef = useRef<WorkflowRunStatus | undefined>(undefined);
  useEffect(() => {
    if (!runStatus) return;
    const previous = lastAnnouncedStatusRef.current;
    lastAnnouncedStatusRef.current = runStatus;
    if (previous === undefined || previous === runStatus || !isTerminalRun(runStatus)) return;
    const label = runTypeCanPark(run?.workflowType)
      ? finalStepView({
          isTerminal: true,
          status: runStatus,
          outcome: run?.outcome,
          resumedAt,
          decidedApproval,
        }).label
      : workStepView({ isTerminal: true, status: runStatus, workflowType: run?.workflowType })
          .label;
    announce(`Run finished: ${label}.`);
  }, [runStatus, run?.workflowType, run?.outcome, resumedAt, decidedApproval]);

  // Same seed-then-observe guard as above, for the approval-pending transition. Seeded on the first
  // commit holding both the run and its first pending-approval list — whichever of the two lands
  // second — so a run already paused when that data arrives announces nothing; only a pause that
  // starts after it is news. Skipped once the run is stale: a stale run's approval step already
  // reads "Status unknown" rather than "Paused", so announcing a pause here would contradict what
  // the timeline shows.
  const lastPausedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (!runStatus || !approvalsLoaded) return;
    const previous = lastPausedRef.current;
    lastPausedRef.current = isPaused;
    if (previous === undefined || previous || !isPaused || isStale) return;
    announce('Approval pending — this run is waiting on a decision.');
  }, [runStatus, approvalsLoaded, isPaused, isStale]);

  // Same seed-then-observe guard, for the run's own flip into stale. Seeded from the first run this
  // mount loads, so a run already stale when it arrives announces nothing — only a flip observed
  // after that is news, the same rule the other two announcements above follow.
  const lastStaleRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (!runStatus) return;
    const previous = lastStaleRef.current;
    lastStaleRef.current = isStale;
    if (previous === undefined || previous || !isStale) return;
    announce('This run record is out of date and will not change further.');
  }, [runStatus, isStale]);

  // Selects the timeline shape and computes every step's state up front, once, from the run's own
  // data — never inferred from engine status alone. `null` only while `run` itself is still null.
  const shapeViews = run
    ? runTypeCanPark(run.workflowType)
      ? {
          kind: 'three' as const,
          approval: approvalStepView({
            isTerminal,
            isStale,
            isPaused,
            everPaused,
            pausedAt,
            resumedAt,
            status: run.status,
            outcome: run.outcome,
            workflowType: run.workflowType,
            decidedApproval,
          }),
          final: finalStepView({
            isTerminal,
            isStale,
            status: run.status,
            outcome: run.outcome,
            resumedAt,
            decidedApproval,
          }),
        }
      : {
          kind: 'two' as const,
          work: workStepView({
            isTerminal,
            isStale,
            status: run.status,
            workflowType: run.workflowType,
          }),
        }
    : null;

  const currentIndex = shapeViews
    ? shapeViews.kind === 'three'
      ? currentStepIndex([shapeViews.approval.state, shapeViews.final.state], isTerminal || isStale)
      : currentStepIndex([shapeViews.work.state], isTerminal || isStale)
    : -1;

  return (
    <div className="view">
      <PageHeader
        eyebrow="Runs"
        title={run ? workflowTypeLabel(run.workflowType) : 'Run timeline'}
        description={headerDescription(run?.workflowType)}
        actions={
          <LinkButton to="/workflow-runs" variant="secondary" size="sm">
            Back to runs
          </LinkButton>
        }
      />

      {run && (
        <p className="answer-detail-meta">
          <Tooltip content={run.workflowId}>
            <span className="mono cell-truncate" tabIndex={0}>
              {shortId(run.workflowId)}
            </span>
          </Tooltip>
          <CopyButton text={run.workflowId} label="Copy id" iconOnly />
          {subjectLink && (
            <LinkButton to={subjectLink.to} variant="ghost" size="sm">
              {subjectLink.label}
            </LinkButton>
          )}
        </p>
      )}

      {error && (
        <Alert
          tone="rejected"
          action={
            <Button variant="secondary" size="sm" onClick={handleFallback}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {!id && (
        <p className="error error--page" role="alert">
          No workflow run id provided.
        </p>
      )}

      {notFound && (
        <EmptyState
          headingLevel={2}
          title="Workflow run not found"
          action={
            <LinkButton to="/workflow-runs" variant="secondary" size="sm">
              Back to runs
            </LinkButton>
          }
        />
      )}

      {!run && !error && !notFound && id && <Skeleton label="Loading run timeline…" />}

      {run && shapeViews && (
        <section className="card">
          <div className="form-actions">
            <Badge tone={runStatusView(run.status).tone}>{runStatusView(run.status).label}</Badge>
            {!isTerminal && !isStale && (
              <span
                className={
                  POLLING_STREAM_STATES.includes(streamState)
                    ? 'connection-chip connection-chip--polling'
                    : 'connection-chip'
                }
              >
                <span>{CONNECTION_LABELS[streamState].label}</span>
                <span className="sr-only"> {CONNECTION_LABELS[streamState].detail}</span>
              </span>
            )}
          </div>

          {isStale && (
            <Alert tone="caution">
              This run record is out of date. The workflow engine no longer has this workflow, so
              the status above is the last one recorded and will not change.
            </Alert>
          )}

          {/* This page refreshes status over a 1.5s SSE stream that falls back to polling, but
              the API's own status read is cached up to 15s and, on an engine failure, falls
              back further to the last durable value — so status here can lag the live run by
              several seconds even while the connection itself reads as live. Hidden once stale:
              nothing refreshes any more, and the alert above already says so. */}
          {!isStale && (
            <p className="cell-sub">Status refreshes periodically and may lag the live run.</p>
          )}

          {/* Rendered once, here, rather than a second time inside whichever step actually
              failed — a failure is the one thing on this page that should never compete with
              itself for a reader's attention. */}
          {isFailed && (
            <p className="error" role="alert">
              {run.errorMessage || 'Reason not recorded'}
            </p>
          )}

          {shapeViews.kind === 'two' ? (
            <ol className="run-rail" role="list">
              <li className={runStepClassName('done')}>
                <RunStepLabel state="done" label="Started" />
                <Timestamp value={run.createdAt} />
              </li>
              <li
                className={runStepClassName(shapeViews.work.state)}
                aria-current={currentIndex === 0 ? 'step' : undefined}
              >
                <RunStepLabel state={shapeViews.work.state} label={shapeViews.work.label} />
                {shapeViews.work.time !== undefined && (
                  <TimelineWhen value={shapeViews.work.time} />
                )}
              </li>
            </ol>
          ) : (
            <ol className="run-rail" role="list">
              <li className={runStepClassName('done')}>
                <RunStepLabel state="done" label="Started" />
                <Timestamp value={run.createdAt} />
              </li>

              <li
                ref={approvalStepRef}
                tabIndex={-1}
                className={runStepClassName(shapeViews.approval.state)}
                aria-current={currentIndex === 0 ? 'step' : undefined}
              >
                <RunStepLabel state={shapeViews.approval.state} label={shapeViews.approval.label} />
                {shapeViews.approval.time !== undefined && (
                  <TimelineWhen value={shapeViews.approval.time} />
                )}
                {shapeViews.approval.decidedBy && (
                  <p className="cell-sub">Decided by {shapeViews.approval.decidedBy}</p>
                )}
                {/* Hidden for a stale run: the engine no longer has this workflow, so no decision
                    made here could ever reach it. */}
                {pendingApproval && !isStale && (
                  <div className="approval-action-card">
                    <p className="approval-action-card-summary">{pendingApproval.summary}</p>
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

              <li
                className={runStepClassName(shapeViews.final.state)}
                aria-current={currentIndex === 1 ? 'step' : undefined}
              >
                <RunStepLabel state={shapeViews.final.state} label={shapeViews.final.label} />
                {shapeViews.final.time !== undefined && (
                  <TimelineWhen value={shapeViews.final.time} />
                )}
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
