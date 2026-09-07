/**
 * Which activity groups heartbeat, and the `startToCloseTimeout` each one declares, as plain data.
 * Pure data with no imports beyond `./ingest-retry-policy`, so the workflow bundle only ever pulls
 * constants from this module — same determinism-fence discipline `ingest-retry-policy.ts`'s own
 * doc comment states (ADR-0003).
 *
 * The property every entry here backs: an activity whose `startToCloseTimeout` is strictly greater
 * than `INGEST_HEARTBEAT_TIMEOUT_MS` pumps a heartbeat (`src/worker/activities.ts`'s `withHeartbeat`)
 * and its `proxyActivities` options declare `heartbeatTimeout: INGEST_HEARTBEAT_TIMEOUT_MS` — a
 * heartbeat with no timeout declared is inert, and a timeout with no heartbeat fails every healthy
 * attempt (`ingest-retry-policy.ts`'s own `INGEST_HEARTBEAT_TIMEOUT_MS` doc comment). An activity
 * whose budget sits at or under that bound, such as `retrieveEvidence`'s 30 s, never appears here.
 */

import { INGEST_START_TO_CLOSE_TIMEOUT_MS } from './ingest-retry-policy';

export const EXTRACT_FACTS_START_TO_CLOSE_TIMEOUT_MS = 5 * 60 * 1000;
export const SYNC_SOURCE_START_TO_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;
export const SYNTHESIZE_ANSWER_START_TO_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;
export const DECOMPOSE_CLAIMS_START_TO_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;
export const CHECK_CONTRADICTIONS_START_TO_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;

export const HEARTBEATING_ACTIVITIES: readonly {
  readonly activity:
    | 'ingestDocumentVersion'
    | 'extractFacts'
    | 'runSourceSync'
    | 'synthesizeAnswer'
    | 'decomposeClaims'
    | 'checkContradictions';
  readonly startToCloseMs: number;
}[] = [
  { activity: 'ingestDocumentVersion', startToCloseMs: INGEST_START_TO_CLOSE_TIMEOUT_MS },
  { activity: 'extractFacts', startToCloseMs: EXTRACT_FACTS_START_TO_CLOSE_TIMEOUT_MS },
  { activity: 'runSourceSync', startToCloseMs: SYNC_SOURCE_START_TO_CLOSE_TIMEOUT_MS },
  { activity: 'synthesizeAnswer', startToCloseMs: SYNTHESIZE_ANSWER_START_TO_CLOSE_TIMEOUT_MS },
  { activity: 'decomposeClaims', startToCloseMs: DECOMPOSE_CLAIMS_START_TO_CLOSE_TIMEOUT_MS },
  {
    activity: 'checkContradictions',
    startToCloseMs: CHECK_CONTRADICTIONS_START_TO_CLOSE_TIMEOUT_MS,
  },
];
