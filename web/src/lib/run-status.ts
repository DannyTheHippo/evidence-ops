import type { BadgeTone } from '../components/ui/Badge';
import type { ApprovalState, WorkflowRun, WorkflowRunStatus, WorkflowRunType } from '../api/client';

export type WorkflowRunOutcome = NonNullable<WorkflowRun['outcome']>;

export interface RunStatusView {
  tone: BadgeTone;
  label: string;
}

const STATUS_VIEWS: Record<WorkflowRunStatus, RunStatusView> = {
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'info', label: 'Running' },
  completed: { tone: 'verified', label: 'Completed' },
  failed: { tone: 'rejected', label: 'Failed' },
};

const OUTCOME_VIEWS: Record<WorkflowRunOutcome, RunStatusView> = {
  resolved: { tone: 'verified', label: 'Resolved' },
  rejected: { tone: 'caution', label: 'Rejected' },
  timed_out: { tone: 'caution', label: 'Approval timed out' },
};

/** The status vocabulary every Runs surface reads — capitalised words, never the raw enum. */
export function runStatusView(status: WorkflowRunStatus): RunStatusView {
  return STATUS_VIEWS[status];
}

/** The workflow's own verdict, rendered beside the status rather than in place of it. */
export function runOutcomeView(outcome: WorkflowRunOutcome): RunStatusView {
  return OUTCOME_VIEWS[outcome];
}

const NON_PARKING_TYPES: ReadonlySet<WorkflowRunType> = new Set<WorkflowRunType>([
  'sync-source',
  'answer-question',
  'rescan-conflicts',
]);

/** Whether a run of this type can park on a human approval. Absent or unrecognised types answer
 *  true: a run whose shape is unknown must not have its approval step silently suppressed. */
export function runTypeCanPark(workflowType?: WorkflowRunType): boolean {
  return !workflowType || !NON_PARKING_TYPES.has(workflowType);
}

const WORK_STEP_LABELS: Partial<Record<WorkflowRunType, string>> = {
  'sync-source': 'Syncing',
  'answer-question': 'Answering',
  'rescan-conflicts': 'Rescanning',
};

/** The label a run type's single work step carries while in flight, for the two-step timeline. */
export function runWorkStepLabel(workflowType?: WorkflowRunType): string {
  return (workflowType && WORK_STEP_LABELS[workflowType]) || 'Working';
}

const APPROVAL_STATE_FOR_OUTCOME: Record<WorkflowRunOutcome, ApprovalState> = {
  resolved: 'approved',
  rejected: 'rejected',
  timed_out: 'timed_out',
};

/** The approval state that corresponds to a terminal run's outcome, for fetching the decided
 *  approval row by state. */
export function approvalStateForOutcome(outcome: WorkflowRunOutcome): ApprovalState {
  return APPROVAL_STATE_FOR_OUTCOME[outcome];
}
