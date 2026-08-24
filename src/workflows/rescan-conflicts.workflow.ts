import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import type { RescanConflictsWorkflowInput, RescanConflictsWorkflowResult } from './types';

/**
 * `Activities` is imported `import type` only — see `sync-source.workflow.ts`'s identical
 * top-of-file comment for why that erasure is what actually keeps this file on the
 * determinism-fenced side of the bundler boundary (ADR-0003).
 */

/**
 * A metric-scoped rescan is pure Mongo read-then-write, idempotent by the same open-conflict/
 * closed-factIds check `ConflictsService.scanForConflicts` documents for `scanForConflictsByMetrics`,
 * and by `retractConflicts`'s own pending-approval guard — a retry after a crash mid-rescan is a
 * safe, cheap no-op rather than a double-write, so this gets the same modest budget
 * `syncActivities` in `sync-source.workflow.ts` uses for its own idempotent, no-model-call
 * activity.
 */
const rescanActivities = proxyActivities<
  Pick<Activities, 'scanForConflictsByMetrics' | 'retractConflicts'>
>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 5 },
});

/**
 * Runs the two halves of a metric-pack activation's rescan for exactly the metrics
 * `MetricPacksService.activate` names as detection-relevant changes (`RescanConflictsWorkflowInput
 * .metricIds`'s own doc comment). Scan-then-retract, not concurrent: the two calls touch disjoint
 * conflict groups — `scanForConflictsByMetrics` only ever creates a conflict for a group with no
 * existing open or matching-closed row, `retractConflicts` only ever closes an already-open one —
 * so the order has no correctness effect; sequenced only for the same one-step-at-a-time shape
 * every other workflow in this directory keeps.
 */
export async function rescanConflicts(
  input: RescanConflictsWorkflowInput,
): Promise<RescanConflictsWorkflowResult> {
  const scanResult = await rescanActivities.scanForConflictsByMetrics(
    input.tenantId,
    input.metricIds,
  );
  const retractResult = await rescanActivities.retractConflicts(input.tenantId, input.metricIds);

  return {
    conflictsCreated: scanResult.conflictsCreated,
    conflictsRetracted: retractResult.conflictsRetracted,
    skippedFactCount: scanResult.skippedFactCount,
  };
}
