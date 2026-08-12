// Matches WorkflowRunPage's poll interval (`web/src/pages/WorkflowRunPage.tsx`'s
// DEFAULT_POLL_INTERVAL_MS) — see `qa.constant.ts`'s identical reasoning for why this backs
// `WorkflowRunsService.streamRun` at the same cadence.
export const WORKFLOW_RUN_STREAM_INTERVAL_MS = 1500;
