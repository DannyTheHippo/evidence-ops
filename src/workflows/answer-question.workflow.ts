import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
import {
  CHECK_CONTRADICTIONS_START_TO_CLOSE_TIMEOUT_MS,
  DECOMPOSE_CLAIMS_START_TO_CLOSE_TIMEOUT_MS,
  SYNTHESIZE_ANSWER_START_TO_CLOSE_TIMEOUT_MS,
} from './activity-heartbeat-policy';
import { INGEST_HEARTBEAT_TIMEOUT_MS } from './ingest-retry-policy';
import type { AnswerQuestionInput, AnswerQuestionResult } from './types';

// Retrieval is a Mongo hybrid-search read plus one Voyage embedding call for the query — cheap
// to retry and fast to fail, unlike the paid model call below, so this group gets more attempts
// and a short overall budget.
const retrievalActivities = proxyActivities<Pick<Activities, 'retrieveEvidence'>>({
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 5,
    // A missing tenantId never appears by retrying (`requireTenantId` in `activities.ts`), and
    // Voyage's own errors here are deterministic for a given input: no configured API key and a
    // malformed embeddings response shape both recur unchanged on the next attempt.
    nonRetryableErrorTypes: [
      'MissingTenantId',
      'VoyageApiKeyMissingError',
      'VoyageInvalidResponseError',
    ],
  },
});

// Paid and non-idempotent: ADR-0003's operational caveat is that Temporal's at-least-once
// activity execution would double-charge a retried LLM call on a worker crash between "call
// succeeded" and "activity reported complete", so this group gets a low `maximumAttempts` and a
// timeout budget generous enough for real model latency rather than Mongo-read speed.
const synthesisActivities = proxyActivities<Pick<Activities, 'synthesizeAnswer'>>({
  startToCloseTimeout: SYNTHESIZE_ANSWER_START_TO_CLOSE_TIMEOUT_MS,
  scheduleToCloseTimeout: '5 minutes',
  // Paired with the heartbeats `synthesizeAnswer` (`src/worker/activities.ts`) emits — a heartbeat
  // with no timeout declared here is inert, and a timeout with no heartbeats fails every healthy
  // call. See `ingest-retry-policy.ts`'s own `INGEST_HEARTBEAT_TIMEOUT_MS` doc comment.
  heartbeatTimeout: INGEST_HEARTBEAT_TIMEOUT_MS,
  retry: {
    maximumAttempts: 2,
    // The spend ceiling and the pricing table are facts a retry cannot change mid-workflow, and
    // a schema-invalid model response recurs for the same prompt. A response that stopped at the
    // output cap or the context window recurs identically against the same (or a longer) prompt,
    // so it joins the same set rather than the transient one. A tenant's daily ceiling does not
    // rise mid-workflow either, and a request with no tenant is refused identically on every
    // retry, so both spend-guard failures join the same non-retryable set.
    nonRetryableErrorTypes: [
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'ModelOutputTruncatedError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
    ],
  },
});

// Same paid, non-idempotent, per-claim model-call profile as `synthesisActivities` above, so this
// group shares its timeout budget and its non-retryable error set verbatim. Both `decomposeClaims`
// and `checkContradictions` never throw on a model-call failure (`ClaimDecompositionService`/
// `ContradictionCheckService` fail open into `unavailable` — see their own doc comments), so this
// group's retry policy exists for the budget and the `MissingTenantId` case, not because either
// activity is expected to reject.
const decompositionActivities = proxyActivities<Pick<Activities, 'decomposeClaims'>>({
  startToCloseTimeout: DECOMPOSE_CLAIMS_START_TO_CLOSE_TIMEOUT_MS,
  scheduleToCloseTimeout: '5 minutes',
  // Paired with the heartbeats `decomposeClaims` (`src/worker/activities.ts`) emits — see
  // `synthesisActivities`'s own comment above for what a heartbeat with no timeout, or a timeout
  // with no heartbeat, each do wrong.
  heartbeatTimeout: INGEST_HEARTBEAT_TIMEOUT_MS,
  retry: {
    maximumAttempts: 2,
    nonRetryableErrorTypes: [
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'ModelOutputTruncatedError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
    ],
  },
});

const contradictionActivities = proxyActivities<Pick<Activities, 'checkContradictions'>>({
  startToCloseTimeout: CHECK_CONTRADICTIONS_START_TO_CLOSE_TIMEOUT_MS,
  scheduleToCloseTimeout: '5 minutes',
  // Paired with the heartbeats `checkContradictions` (`src/worker/activities.ts`) emits — same
  // pairing `decompositionActivities` above declares.
  heartbeatTimeout: INGEST_HEARTBEAT_TIMEOUT_MS,
  retry: {
    maximumAttempts: 2,
    nonRetryableErrorTypes: [
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'ModelOutputTruncatedError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
    ],
  },
});

// Pure, local, deterministic-given-its-inputs verification — no model call, no external network
// request (see `GroundingGateService`'s own doc comment) — so this is the cheapest activity to
// retry and gets the shortest timeout.
const groundingActivities = proxyActivities<Pick<Activities, 'groundingCheck'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    // A missing tenantId never appears by retrying (`requireTenantId` in `activities.ts`).
    nonRetryableErrorTypes: ['MissingTenantId'],
  },
});

// A Mongo update against the single `answerId` row (see `AnswerQuestionInput`'s doc comment), not
// an insert — retrying it after a crash between "write succeeded" and "activity reported complete"
// re-applies the same field values to the same row rather than creating a second `Answer` — so
// this activity is idempotent, which is what makes a retry safe here. `maximumAttempts` stays at 2
// regardless: raising it is an operational tuning decision, not a consequence of idempotency.
const persistActivities = proxyActivities<Pick<Activities, 'persistAnswer'>>({
  startToCloseTimeout: '10 seconds',
  scheduleToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 2,
    // A missing tenantId never appears by retrying (`requireTenantId` in `activities.ts`).
    nonRetryableErrorTypes: ['MissingTenantId'],
  },
});

/**
 * Second workflow in the tree (ADR-0003): retrieve → synthesize → decompose claims → check
 * contradictions → verify grounding → persist. Orchestration only — every side effect (the Mongo
 * hybrid search, the model calls, the verification pass, the Mongo write) lives in an activity;
 * this function just sequences their results and threads `tenantId` through unopened to every
 * activity that scopes on it (`retrieveEvidence`, `synthesizeAnswer`, `decomposeClaims`,
 * `checkContradictions`, `groundingCheck`, `persistAnswer`).
 */
export async function answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
  const chunks = await retrievalActivities.retrieveEvidence({
    questionText: input.questionText,
    tenantId: input.tenantId,
  });

  const { contract: outcome, usage } = await synthesisActivities.synthesizeAnswer({
    questionText: input.questionText,
    chunks,
    tenantId: input.tenantId,
  });

  const { atoms } = await decompositionActivities.decomposeClaims({
    outcome,
    tenantId: input.tenantId,
  });

  const { contradictedClaimIndexes } = await contradictionActivities.checkContradictions({
    outcome,
    atoms,
    retrievedChunks: chunks,
    tenantId: input.tenantId,
  });

  const grounding = await groundingActivities.groundingCheck({
    outcome,
    retrievedChunks: chunks,
    tenantId: input.tenantId,
    questionText: input.questionText,
    atoms,
    contradictedClaimIndexes,
  });

  const persisted = await persistActivities.persistAnswer({
    answerId: input.answerId,
    questionText: input.questionText,
    tenantId: input.tenantId,
    retrievedChunkIds: chunks.map((chunk) => chunk.chunkId),
    // `grounding.outcome`, not the model's raw `outcome` above — the gate's verified outcome is
    // what gets persisted and returned (see `groundingCheck`'s doc comment in `activities.ts`).
    outcome: grounding.outcome,
    claims: grounding.claims,
    claimCoverage: grounding.claimCoverage,
    verificationReport: grounding.verificationReport,
    conflictIds: grounding.conflictIds,
    atoms: grounding.atoms,
    usage,
  });

  return {
    answerId: persisted.answerId,
    outcomeKind: persisted.outcomeKind,
    claimCoverage: persisted.claimCoverage,
  };
}
