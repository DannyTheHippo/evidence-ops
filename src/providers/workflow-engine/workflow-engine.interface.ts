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
}

export const WORKFLOW_ENGINE = Symbol('WORKFLOW_ENGINE');
