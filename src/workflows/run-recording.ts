import { log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import type { ResolveConflictOutcome } from './types';

/**
 * `Activities` is imported `import type` only — see `ingest-document-version.workflow.ts`'s
 * top-of-file comment for why that erasure is what keeps this file on the determinism-fenced
 * side of the bundler boundary (ADR-0003).
 */

// Pure Mongo update against the single `workflowId` row (`WorkflowRunsService.recordEnd`),
// idempotent — a retry after a crash between "write succeeded" and "activity reported complete"
// re-applies the same terminal fields to the same row. Cheap and side-effect-free otherwise, so
// this gets the same budget every other pure-Mongo, no-model-call group in this codebase uses.
export const runActivities = proxyActivities<Pick<Activities, 'recordWorkflowRunEnd'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

/**
 * Runs the `recordWorkflowRunEnd` activity and never rejects. The run row is a measurement of the
 * workflow, so the write FAILS OPEN: a rejection — after the activity's own retries are spent — is
 * logged at `warn` with the `workflowId` and `status` it was recording, and swallowed, so the
 * calling workflow's own result or error stands.
 */
export async function recordRunEndSafely(
  input: Parameters<Activities['recordWorkflowRunEnd']>[0],
): Promise<void> {
  try {
    await runActivities.recordWorkflowRunEnd(input);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    log.warn('Failed to record workflow run terminal status', {
      workflowId: input.workflowId,
      status: input.status,
      error: error instanceof Error ? error.message : String(error),
      cause: cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined,
    });
  }
}

/**
 * Runs `body` and marks this execution's `workflow_runs` row terminal on either exit —
 * `completed` with the outcome `toOutcome` reads off the result when `body` resolves, or `failed`
 * carrying the error's message when `body` rejects. `toOutcome` is absent for a workflow with no
 * outcome vocabulary of its own (`answer-question`, `ingest-document-version`) — those runs record
 * `completed` with no `outcome` field.
 *
 * The recording write FAILS OPEN through {@link recordRunEndSafely}: a rejected recording never
 * changes the workflow's outcome. A resolved `body` always returns its result, and a rejected
 * `body` always rethrows its own original error.
 *
 * `workflowInfo().workflowId` is deterministic (this execution's own id never changes on replay),
 * already relied on the same way in `resolve-conflict.workflow.ts`.
 */
export async function withRunRecording<T>(
  body: () => Promise<T>,
  toOutcome?: (result: T) => ResolveConflictOutcome | undefined,
): Promise<T> {
  const workflowId = workflowInfo().workflowId;
  let result: T;
  try {
    result = await body();
  } catch (error) {
    await recordRunEndSafely({
      workflowId,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await recordRunEndSafely({ workflowId, status: 'completed', outcome: toOutcome?.(result) });
  return result;
}
