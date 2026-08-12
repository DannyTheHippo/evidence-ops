import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import type {
  ApprovalDecisionSignal,
  IngestDocumentVersionInput,
  IngestDocumentVersionResult,
} from './types';

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

// `requestIngestApproval` is `approvalModel.create` under the hood
// (`MongoApprovalChannel.requestApproval`) — an insert, not an update-the-same-row pattern — so a
// retry after a crash between "insert succeeded" and "activity reported complete" orphans a
// second pending `Approval` row rather than being a safe no-op. Same operational caution
// `resolve-conflict.workflow.ts`'s `approvalRequestActivities` applies to its own non-idempotent
// call, for the same reason: `maximumAttempts` stays low.
const approvalRequestActivities = proxyActivities<Pick<Activities, 'requestIngestApproval'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

// Pure Mongo read (`MongoApprovalChannel.getDecision`), idempotent and side-effect-free, so this
// gets the same cheap-to-retry budget every other pure-read activity group in this file does.
const approvalDecisionActivities = proxyActivities<Pick<Activities, 'getApprovalDecision'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

/**
 * Fired to wake this workflow from its approval wait — never trusted as the verdict itself. See
 * `resolve-conflict.workflow.ts`'s own `approvalDecisionSignal` doc comment for the fail-closed
 * discipline this mirrors exactly (the handler below never reads `claimedDecision`, only
 * `getApprovalDecision`'s durable row decides), and `ApprovalDecisionSignal`'s doc comment
 * (`./types.ts`) for why both workflows register under the identical signal name
 * `'approvalDecision'`: `ApprovalsService.decide()` hardcodes that one name and wakes whichever
 * workflow the `Approval` row's `workflowId` points at, never caring which kind of gate it is.
 */
export const ingestApprovalDecisionSignal =
  defineSignal<[ApprovalDecisionSignal]>('approvalDecision');

// Same 24-hour budget `resolve-conflict.workflow.ts`'s `APPROVAL_TIMEOUT` uses, and the same
// reasoning: long enough for a human reviewer to act within a normal working cycle without
// leaving the `Approval` row waiting indefinitely, short enough that `getApprovalDecision`'s
// fail-closed-to-rejected-on-`pending` behavior only ever fires because nobody answered, not
// because the window was unreasonably tight.
const APPROVAL_TIMEOUT = '24 hours';

/** Chunk+embed → extract facts → scan for conflicts, unconditionally — the same three-call chain
 *  this workflow always ran before the approval gate existed. Factored out so both the gated and
 *  ungated paths in `ingestDocumentVersion` below call exactly one copy of it, rather than the
 *  gate's `if` duplicating the chain. */
async function runIngestPipeline(documentVersionId: string): Promise<IngestDocumentVersionResult> {
  const result = await ingestActivities.ingestDocumentVersion(documentVersionId);
  await factsActivities.extractFacts(documentVersionId);
  await conflictsActivities.scanForConflicts();
  return result;
}

/**
 * Runs the whole ingest chain for one document version: chunk+embed → extract facts → scan for
 * conflicts, optionally gated behind a human approval first (D5 of the approvals milestone).
 * Orchestration only — every side effect (the Mongo reads/writes, the embedding call, the
 * fact-extraction model call, the approval request/decision read) lives in an activity; this
 * function just sequences their calls, the same shape `resolve-conflict.workflow.ts` and
 * `answer-question.workflow.ts` use for their own chains.
 *
 * **The gate is opt-in and defaults to off.** `input.requireApproval` absent or `false` skips
 * straight to `runIngestPipeline` — an ordinary upload is never blocked, deliberately: a demo
 * where every upload stalls pending approval is a worse demo than one where the machinery is
 * available but not mandatory, and the point this workflow proves is that the same durable
 * signal-plus-`condition()` discipline `resolveConflict` established generalizes to a second kind
 * of gated action, not that ingestion itself needs gating by default.
 *
 * When gated, this reuses `resolveConflict`'s exact wake-up discipline: the signal handler only
 * flips a flag, never reads its payload, and on waking the workflow re-reads the durable
 * `Approval` row via `getApprovalDecision` rather than trusting anything the signal carried — a
 * spoofed or stale signal cannot forge an approval here any more than it can there. A timeout is
 * not an approval either: it fails closed to `gateOutcome: 'timed_out'` without ever calling
 * `getApprovalDecision`, mirroring `resolveConflict`'s `timed_out` branch exactly.
 *
 * A rejected or timed-out gate never calls `runIngestPipeline` at all, so the version's own
 * `ingestionStatus` stays at its schema default of `'pending'` — truthfully, since ingestion
 * genuinely never started. No new persisted state is needed to represent "blocked pending
 * approval": the durable `Approval` row already carries that record, and a human reviewing the
 * pending-approvals inbox (`ApprovalsService.listPending`) sees it there.
 */
export async function ingestDocumentVersion(
  input: IngestDocumentVersionInput,
): Promise<IngestDocumentVersionResult> {
  if (!input.requireApproval) {
    return runIngestPipeline(input.documentVersionId);
  }

  const approval = await approvalRequestActivities.requestIngestApproval({
    action: 'ingest_document_version',
    summary: input.documentTitle
      ? `Approve ingesting '${input.documentTitle}' (version '${input.documentVersionId}')`
      : `Approve ingesting document version '${input.documentVersionId}'`,
    subject: { entityType: 'DocumentVersion', entityId: input.documentVersionId },
    tenantId: input.tenantId,
    // `workflowInfo()` is deterministic (this execution's own id never changes on replay) — see
    // `ApprovalRequest.workflowId`'s doc comment for why the HTTP decision endpoint needs it.
    workflowId: workflowInfo().workflowId,
  });

  // The handler only ever flips this flag — see `ingestApprovalDecisionSignal`'s own doc comment
  // for why its payload is never read.
  let signaled = false;
  setHandler(ingestApprovalDecisionSignal, () => {
    signaled = true;
  });

  const woke = await condition(() => signaled, APPROVAL_TIMEOUT);

  if (!woke) {
    // A timeout is not an approval and never becomes one by falling through to
    // `getApprovalDecision` — fails closed by returning `timed_out` directly, with no further
    // read, and never calling `runIngestPipeline`.
    return { chunksCreated: 0, alreadyIngested: false, gateOutcome: 'timed_out' };
  }

  // Woken by a signal — read the durable row, never the signal's own payload (see
  // `ingestApprovalDecisionSignal`'s doc comment). `getApprovalDecision` itself fails closed to
  // `rejected` for any state that isn't exactly `approved`
  // (`MongoApprovalChannel.getDecision`'s own doc comment), so this branch never needs to
  // special-case `pending`/unknown states itself.
  const decision = await approvalDecisionActivities.getApprovalDecision(
    approval.id,
    input.tenantId,
  );

  if (decision.decision !== 'approved') {
    return { chunksCreated: 0, alreadyIngested: false, gateOutcome: 'rejected' };
  }

  const result = await runIngestPipeline(input.documentVersionId);
  return { ...result, gateOutcome: 'approved' };
}
