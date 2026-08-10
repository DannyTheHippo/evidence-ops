import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import type { IngestDocumentVersionInput, IngestDocumentVersionResult } from './types';

// `Activities` is imported `import type` only — TypeScript erases the statement entirely before
// the worker's webpack bundler ever sees a module graph, so `src/worker/activities.ts`'s real
// imports (@nestjs/common, IngestionService, mongoose transitively) never reach this file. That
// erasure is exactly the case the ESLint fence *can't* see (ADR-0003) and the bundler is the
// gate that actually matters — see `test/worker/determinism-fence.spec.ts`.

// Chunk+embed: one Voyage embedding call plus Mongo reads/writes, guarded by
// `IngestionService.ingestVersion`'s own compare-and-set lease (see its doc comment) — a retry
// after the lease has moved on is a safe, cheap no-op rather than a double-write, so this group
// tolerates the same retry budget the original single-activity workflow used.
const ingestActivities = proxyActivities<Pick<Activities, 'ingestDocumentVersion'>>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

// Fact extraction is paid and non-idempotent for its prose path: it calls a model once per
// ingested chunk. Same ADR-0003 double-charge caveat `answer-question.workflow.ts`'s
// `synthesisActivities` documents — Temporal's at-least-once execution would re-charge a retried
// call on a worker crash between "call succeeded" and "activity reported complete" — so this
// group gets a low `maximumAttempts` and a timeout budget sized for real model latency across
// every chunk in a version, not Mongo-read speed. (`FactsService.extractFacts` is still
// idempotent by existence check, so a *whole-activity* retry after a full success is a cheap
// no-op; the caveat is only about a retry racing an in-flight, uncommitted model call.)
const factsActivities = proxyActivities<Pick<Activities, 'extractFacts'>>({
  startToCloseTimeout: '5 minutes',
  scheduleToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 2 },
});

// Pure Mongo read-then-insert, idempotent by open-conflict check (`ConflictsService
// .scanForConflicts`'s own doc comment) — no model call, no external network request, so this is
// the cheapest activity in the chain to retry and gets the shortest timeout.
const conflictsActivities = proxyActivities<Pick<Activities, 'scanForConflicts'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

/**
 * Runs the whole ingest chain for one document version: chunk+embed → extract facts → scan for
 * conflicts. Orchestration only — every side effect (the Mongo reads/writes, the embedding call,
 * the fact-extraction model call) lives in an activity; this function just sequences their calls,
 * the same shape `answer-question.workflow.ts` uses for its own multi-step chain. Facts and
 * conflicts are scanned unconditionally after ingestion, not only on a fresh ingest: both
 * `FactsService.extractFacts` and `ConflictsService.scanForConflicts` are themselves idempotent
 * (skip-if-already-extracted, skip-if-already-open), so re-running them on an
 * already-ingested version is a safe, cheap no-op rather than a special case this workflow needs
 * to branch on.
 */
export async function ingestDocumentVersion(
  input: IngestDocumentVersionInput,
): Promise<IngestDocumentVersionResult> {
  const result = await ingestActivities.ingestDocumentVersion(input.documentVersionId);
  await factsActivities.extractFacts(input.documentVersionId);
  await conflictsActivities.scanForConflicts();
  return result;
}
