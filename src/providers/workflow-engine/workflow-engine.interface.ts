/**
 * Provisional shape — no Temporal implementation exists yet (`@temporalio/*` is scaffolded but
 * unwired repo-wide; see `.claude/CLAUDE.md`). A later step owns the concrete engine.
 */
export type WorkflowStatus = 'running' | 'completed' | 'failed';

export interface WorkflowHandle {
  readonly id: string;
  readonly status: WorkflowStatus;
}

export interface WorkflowEngine {
  start(workflowType: string, input: unknown): Promise<WorkflowHandle>;
  status(id: string): Promise<WorkflowHandle>;
  /** Wakes a running workflow's `condition()` wait (D3 of the approvals milestone —
   *  `resolve-conflict.workflow.ts`'s `approvalDecisionSignal`). `payload` is advisory only: the
   *  signalled workflow re-reads its own durable state rather than trusting it (see that signal's
   *  own doc comment), so this method's contract is "deliver a wake-up", not "deliver a verdict". */
  signal(id: string, signalName: string, payload: unknown): Promise<void>;
}

export const WORKFLOW_ENGINE = Symbol('WORKFLOW_ENGINE');
