import type { WorkflowRun } from '../api/client';

/**
 * Whether a run has stopped moving. `queued` and `running` are in flight; `completed` and `failed`
 * are both ends of the road — a poller stops on either, so the two are one condition rather than a
 * success check with a failure case bolted on.
 */
export function isTerminalRun(status: WorkflowRun['status']): boolean {
  return status === 'completed' || status === 'failed';
}
