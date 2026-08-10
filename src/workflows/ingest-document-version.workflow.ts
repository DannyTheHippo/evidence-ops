import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import type { IngestDocumentVersionInput, IngestDocumentVersionResult } from './types';

// `Activities` is imported `import type` only — TypeScript erases the statement entirely before
// the worker's webpack bundler ever sees a module graph, so `src/worker/activities.ts`'s real
// imports (@nestjs/common, IngestionService, mongoose transitively) never reach this file. That
// erasure is exactly the case the ESLint fence *can't* see (ADR-0003) and the bundler is the
// gate that actually matters — see `test/worker/determinism-fence.spec.ts`.
const activities = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

/**
 * First workflow in the tree. It exists to prove durability and the determinism fence, not as
 * the final shape — `answerQuestion` (the real multi-step retrieve/synthesize/verify workflow,
 * see ADR-0003) is the second, wired alongside this one in `index.ts`. One activity call here is
 * enough to demonstrate the failure/recovery property: killing the worker mid-run and restarting
 * it resumes here.
 */
export async function ingestDocumentVersion(
  input: IngestDocumentVersionInput,
): Promise<IngestDocumentVersionResult> {
  return activities.ingestDocumentVersion(input.documentVersionId);
}
