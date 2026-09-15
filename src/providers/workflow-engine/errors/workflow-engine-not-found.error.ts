/**
 * Thrown by `WorkflowEngine.status()` when the engine can say with confidence that `workflowId`
 * is not known to it — Temporal's own `WorkflowNotFoundError`, including a workflow whose history
 * already fell out of the namespace's retention window. Every other `status()` failure (engine
 * unreachable, timed out, misconfigured auth) rejects with its own error unchanged, so a caller
 * tells "does not exist" apart from "the call failed" with `instanceof WorkflowEngineNotFoundError`.
 */
export class WorkflowEngineNotFoundError extends Error {
  constructor(
    public readonly workflowId: string,
    cause?: unknown,
  ) {
    super(`Workflow '${workflowId}' is not known to the engine`, { cause });
    this.name = 'WorkflowEngineNotFoundError';
  }
}
