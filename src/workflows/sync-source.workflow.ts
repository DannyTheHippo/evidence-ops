import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import { SYNC_SOURCE_START_TO_CLOSE_TIMEOUT_MS } from './activity-heartbeat-policy';
import { INGEST_HEARTBEAT_TIMEOUT_MS } from './ingest-retry-policy';
import type { SyncSourceWorkflowInput } from './types';

/**
 * `Activities` is imported `import type` only — see `ingest-document-version.workflow.ts`'s
 * identical top-of-file comment for why that erasure is what actually keeps this file on the
 * determinism-fenced side of the bundler boundary (ADR-0003).
 */

/**
 * A sync sweep is a filesystem/network read plus a bounded number of document uploads — cheap and
 * safely retriable on its own (`SourcesService.runSync`'s lease CAS makes a retry after a crash a
 * clean no-op or a superseded no-op, never a double-write), so this gets the same modest budget
 * `conflictsActivities` in `ingest-document-version.workflow.ts` uses for its own idempotent,
 * no-model-call activity.
 */
const syncActivities = proxyActivities<Pick<Activities, 'runSourceSync'>>({
  startToCloseTimeout: SYNC_SOURCE_START_TO_CLOSE_TIMEOUT_MS,
  scheduleToCloseTimeout: '5 minutes',
  // Paired with the heartbeats `runSourceSync` (`src/worker/activities.ts`) emits — a heartbeat
  // with no timeout declared here is inert, and a timeout with no heartbeats fails every healthy
  // sweep. See `ingest-retry-policy.ts`'s own `INGEST_HEARTBEAT_TIMEOUT_MS` doc comment.
  heartbeatTimeout: INGEST_HEARTBEAT_TIMEOUT_MS,
  retry: { maximumAttempts: 5 },
});

/**
 * Caps how many sweeps one workflow execution's history holds before it calls `continueAsNew` —
 * the same "bound Temporal's replay history" concern every long-lived polling loop in Temporal
 * needs, sized generously since each iteration's history footprint here is a single activity call.
 */
const MAX_ITERATIONS_BEFORE_CONTINUE = 50;

/**
 * The recurring sync loop `SourcesService.requestSync` starts, one execution per source
 * (`Source.syncWorkflowId` is the duplicate-loop guard on the service side). Every iteration calls
 * the `runSourceSync` activity, which re-reads the `Source` row fresh — this workflow carries no
 * sync-relevant state of its own beyond `input.sourceId`, so a source's `enabled`/`intervalMs`/
 * `path` can change between iterations and the very next sweep picks it up.
 *
 * Three ways an iteration ends the loop, matching `RunSyncResult`'s own doc comment:
 * `disabled: true` (the source was turned off, or no longer exists) exits outright; `intervalMs:
 * null` with `disabled: false` (a one-shot sync, or this execution's lease was lost to a newer
 * attempt) also exits, without implying the source itself is disabled; otherwise the workflow
 * sleeps for `intervalMs` and sweeps again.
 */
export async function syncSource(input: SyncSourceWorkflowInput): Promise<void> {
  for (let iteration = 0; iteration < MAX_ITERATIONS_BEFORE_CONTINUE; iteration++) {
    const result = await syncActivities.runSourceSync(input.sourceId);

    if (result.disabled) {
      return;
    }

    if (result.intervalMs === null) {
      return;
    }

    await sleep(result.intervalMs);
  }

  await continueAsNew<typeof syncSource>(input);
}
