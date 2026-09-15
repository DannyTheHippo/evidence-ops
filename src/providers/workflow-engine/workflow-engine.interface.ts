/**
 * `WORKFLOW_ENGINE` binds to `TemporalWorkflowEngine`, which drives durable execution through
 * `@temporalio/*`. `FakeWorkflowEngine` is the test double — `test/utils/create-test-app.ts`
 * overrides the token back to it so no unit/e2e spec reaches a live Temporal server.
 */
export type WorkflowStatus = 'running' | 'completed' | 'failed';

export interface WorkflowHandle {
  readonly id: string;
  readonly status: WorkflowStatus;
}

export interface WorkflowEngine {
  start(workflowType: string, input: unknown): Promise<WorkflowHandle>;
  /** Rejects with `WorkflowEngineNotFoundError` (`./errors/workflow-engine-not-found.error`) when
   *  the engine positively reports `id` unknown to it. Every other failure — unreachable, timed
   *  out, unauthenticated — rejects with its own error instead, so a caller can tell "this
   *  workflow does not exist" apart from "the call failed" with `instanceof`. */
  status(id: string): Promise<WorkflowHandle>;
  /** Wakes a running workflow's `condition()` wait (D3 of the approvals milestone —
   *  `resolve-conflict.workflow.ts`'s `approvalDecisionSignal`). `payload` is advisory only: the
   *  signalled workflow re-reads its own durable state rather than trusting it (see that signal's
   *  own doc comment), so this method's contract is "deliver a wake-up", not "deliver a verdict". */
  signal(id: string, signalName: string, payload: unknown): Promise<void>;
}

export const WORKFLOW_ENGINE = Symbol('WORKFLOW_ENGINE');
