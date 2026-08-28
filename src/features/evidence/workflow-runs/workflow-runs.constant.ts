// Matches WorkflowRunPage's poll interval (`web/src/pages/WorkflowRunPage.tsx`'s
// DEFAULT_POLL_INTERVAL_MS) — see `qa.constant.ts`'s identical reasoning for why this backs
// `WorkflowRunsService.streamRun` at the same cadence.
export const WORKFLOW_RUN_STREAM_INTERVAL_MS = 1500;

// Minimum spacing `WorkflowRunsService.getLiveStatus` enforces between two `WorkflowEngine.status`
// calls for the same workflow id, independent of `WORKFLOW_RUN_STREAM_INTERVAL_MS`'s much faster
// Mongo-poll cadence. Every concurrent reader of the same run — `streamRun`'s own per-tick poll and
// any parallel `findById`/`peekRun` call — shares the cached result until it expires, so one open
// `WorkflowRunPage` tab costs a bounded, low rate of Temporal calls rather than one per Mongo tick.
export const WORKFLOW_RUN_ENGINE_STATUS_CACHE_MS = 15_000;
