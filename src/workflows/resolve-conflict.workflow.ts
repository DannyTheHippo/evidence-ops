import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import { withRunRecording } from './run-recording';
import type {
  ApprovalDecisionSignal,
  ResolveConflictWorkflowInput,
  ResolveConflictWorkflowResult,
} from './types';

/**
 * Fired to wake this workflow from its approval wait (see `condition()` below) — never trusted as
 * the verdict itself. The handler below never reads `ApprovalDecisionSignal.claimedDecision` —
 * only `getApprovalDecision`, reading the durable `Approval` row, decides the outcome. This is
 * the fail-closed guarantee `ApprovalChannel`
 * (`src/providers/approval-channel/approval-channel.interface.ts`) documents: "never the signal
 * payload itself, so a spoofed or stale signal can't forge an approval." Registered under the
 * same signal name `ingest-document-version.workflow.ts`'s own gate uses — see
 * `ApprovalDecisionSignal`'s doc comment (`./types.ts`) for why that sharing is load-bearing.
 */
export const approvalDecisionSignal = defineSignal<[ApprovalDecisionSignal]>('approvalDecision');

// Two pure Mongo reads (the conflict, then its facts) — same cheap-to-retry reasoning
// `conflictsActivities`/`groundingActivities` use in the other two workflows: no model call, no
// external network request, so this group tolerates the most attempts and the shortest timeout.
const conflictActivities = proxyActivities<Pick<Activities, 'loadConflict'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

// `requestConflictApproval` is `approvalModel.create` under the hood
// (`MongoApprovalChannel.requestApproval`) — an insert, not `persistActivities`'
// update-the-same-row pattern in `answer-question.workflow.ts` — so a retry after a crash between
// "insert succeeded" and "activity reported complete" orphans a second pending `Approval` row
// rather than being a safe no-op. `maximumAttempts` stays low for that reason, the same
// operational caution `synthesisActivities` applies there to its own non-idempotent call.
const approvalRequestActivities = proxyActivities<Pick<Activities, 'requestConflictApproval'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

// Pure Mongo read (`MongoApprovalChannel.getDecision`), idempotent and side-effect-free, so this
// gets the same cheap-to-retry budget `conflictActivities` above does.
const approvalDecisionActivities = proxyActivities<Pick<Activities, 'getApprovalDecision'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

// A Mongo update against the single `conflictId` row (`ConflictsService.recordResolution`), not an
// insert — retrying it after a crash re-applies the same field values to the same row, the same
// idempotency `persistActivities` relies on in `answer-question.workflow.ts` for its own low
// `maximumAttempts`.
const resolutionActivities = proxyActivities<Pick<Activities, 'recordConflictResolution'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

// `expireApproval` (`ApprovalsService.expire`) is a `state: 'pending'`-guarded update against the
// single `approval.id` row, not an insert — retrying it after a crash re-applies the same
// terminal state to the same row, the same idempotency `resolutionActivities` above relies on for
// its own low `maximumAttempts`.
const approvalExpiryActivities = proxyActivities<Pick<Activities, 'expireApproval'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

// ADR-0003's own description of this milestone's approval gate: "await condition(pred, '24
// hours')". A day is long enough for a human reviewer to see and act on the request across a
// normal working cycle without leaving the workflow (and the `Approval` row it created) waiting
// indefinitely; `getApprovalDecision` fails closed to `rejected` on a still-`pending` row
// regardless of how long the wait was, so a shorter window would only make legitimate approvals
// race the clock, not change what an unanswered request means.
const APPROVAL_TIMEOUT = '24 hours';

/**
 * Third workflow in the tree (ADR-0003, D2 of the approvals milestone): load the conflict, ask a
 * human to approve resolving it in favor of the caller's proposed `winningFactId`, then durably
 * wait for that answer — resolving nothing until one arrives. Orchestration only: every side
 * effect (the Mongo reads, the approval request, the decision read, the resolution write) lives in
 * an activity.
 *
 * `winningFactId` is not chosen here — see `ResolveConflictWorkflowInput`'s own doc comment
 * (`./types.ts`) for why it travels in on `input` instead. This function's only job is gating that
 * proposal behind a human, never inventing or second-guessing it. `input.ruleFired`/
 * `input.proposedWinnerFactId` travel the same way, into every `recordConflictResolution` call
 * below unchanged — this function never recomputes them either.
 *
 * Wrapped by {@link withRunRecording} in the exported `resolveConflict` below, reading its
 * `outcome` off the returned `ResolveConflictWorkflowResult.outcome` — already exactly the
 * `resolved`/`rejected`/`timed_out` vocabulary the run's own `outcome` field carries.
 */
async function runResolveConflict(
  input: ResolveConflictWorkflowInput,
): Promise<ResolveConflictWorkflowResult> {
  const candidate = await conflictActivities.loadConflict({
    conflictId: input.conflictId,
    winningFactId: input.winningFactId,
    tenantId: input.tenantId,
  });

  const winner = candidate.values.find((value) => value.factId === candidate.winningFactId);
  if (!winner) {
    // Invariant violation, not a normal branch: `loadConflict`
    // (`ConflictsService.loadConflictForResolution`) already validated `winningFactId` is one of
    // the conflict's own `factIds`, and `values` is built from exactly those ids — a
    // `winningFactId` unable to find its own value here means the activity and this workflow have
    // drifted out of sync.
    throw new Error(
      `loadConflict returned no value for winningFactId '${candidate.winningFactId}' among ` +
        `conflict '${input.conflictId}''s own values`,
    );
  }

  const losingValues = candidate.values.filter((value) => value.factId !== candidate.winningFactId);
  // Names which surface proposed this resolution — `'api'` (the interactive REST path) or `'mcp'`
  // (`request_resolution`) — directly in the text a reviewer reads, so an approval requested by an
  // AI client holding a PAT is never indistinguishable from one a colleague proposed by hand.
  const originNote =
    input.requestedByOrigin === undefined ? '' : ` [requested via ${input.requestedByOrigin}]`;
  const summary =
    `Resolve ${candidate.factKey.entity} ${candidate.factKey.metric} (${candidate.factKey.period}) ` +
    `in favor of ${winner.value}${winner.unit} (source '${winner.sourceChunkId}') over ` +
    losingValues
      .map((value) => `${value.value}${value.unit} (source '${value.sourceChunkId}')`)
      .join(', ') +
    originNote;

  const approval = await approvalRequestActivities.requestConflictApproval({
    action: 'resolve_conflict',
    summary,
    subject: { entityType: 'Conflict', entityId: input.conflictId },
    requestedBy: input.requestedBy,
    tenantId: input.tenantId,
    // `workflowInfo()` is deterministic (this execution's own id never changes on replay) — see
    // `ApprovalRequest.workflowId`'s doc comment for why the HTTP decision endpoint (D3) needs it.
    workflowId: workflowInfo().workflowId,
  });

  // The handler only ever flips this flag — see `approvalDecisionSignal`'s own doc comment for why
  // its payload is never read.
  let signaled = false;
  setHandler(approvalDecisionSignal, () => {
    signaled = true;
  });

  const woke = await condition(() => signaled, APPROVAL_TIMEOUT);

  if (!woke) {
    // A timeout is not an approval and never becomes one by falling through to
    // `getApprovalDecision` — fails closed by recording `timed_out` directly, with no further
    // read. `expireApproval` moves the `Approval` row itself to `timed_out` first, so the row
    // leaves the pending inbox and can never be decided afterwards — without this, a human could
    // still click Approve on a row this workflow has already given up waiting on, writing a
    // decision (and an audit row) for an execution that no longer exists to signal. Run before
    // `recordConflictResolution` so the row a still-open HTTP request might read next is never
    // caught mid-transition.
    await approvalExpiryActivities.expireApproval(approval.id, input.tenantId);
    await resolutionActivities.recordConflictResolution({
      conflictId: input.conflictId,
      outcome: 'timed_out',
      tenantId: input.tenantId,
      ruleFired: input.ruleFired,
      proposedWinnerFactId: input.proposedWinnerFactId,
    });
    return { conflictId: input.conflictId, outcome: 'timed_out' };
  }

  // Woken by a signal — read the durable row, never the signal's own payload (see
  // `approvalDecisionSignal`'s doc comment). `getApprovalDecision` itself fails closed to
  // `rejected` for any state that isn't exactly `approved`
  // (`MongoApprovalChannel.getDecision`'s own doc comment), so this branch never needs to
  // special-case `pending`/unknown states itself.
  const decision = await approvalDecisionActivities.getApprovalDecision(
    approval.id,
    input.tenantId,
  );

  if (decision.decision !== 'approved') {
    await resolutionActivities.recordConflictResolution({
      conflictId: input.conflictId,
      outcome: 'rejected',
      decidedBy: decision.decidedBy,
      reason: decision.reason,
      tenantId: input.tenantId,
      ruleFired: input.ruleFired,
      proposedWinnerFactId: input.proposedWinnerFactId,
    });
    return { conflictId: input.conflictId, outcome: 'rejected' };
  }

  await resolutionActivities.recordConflictResolution({
    conflictId: input.conflictId,
    outcome: 'resolved',
    winningFactId: candidate.winningFactId,
    decidedBy: decision.decidedBy,
    reason: decision.reason,
    tenantId: input.tenantId,
    ruleFired: input.ruleFired,
    proposedWinnerFactId: input.proposedWinnerFactId,
  });

  return {
    conflictId: input.conflictId,
    outcome: 'resolved',
    winningFactId: candidate.winningFactId,
    winningValue: winner.value,
    winningUnit: winner.unit,
  };
}

export async function resolveConflict(
  input: ResolveConflictWorkflowInput,
): Promise<ResolveConflictWorkflowResult> {
  return withRunRecording(
    () => runResolveConflict(input),
    (result) => result.outcome,
  );
}
