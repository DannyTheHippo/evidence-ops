import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../worker/activities';
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
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 2,
    // The spend ceiling and the pricing table are facts a retry cannot change mid-workflow, and
    // a schema-invalid model response recurs for the same prompt. A tenant's daily ceiling does
    // not rise mid-workflow either, and a request with no tenant is refused identically on every
    // retry, so both spend-guard failures join the same non-retryable set.
    nonRetryableErrorTypes: [
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
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

// Paid, non-idempotent, and iterative: `AgenticRetrievalService.gatherEvidence` can spend up to
// `config.agenticRetrieval.maxIterations` model calls (plus a Voyage-backed `search_evidence` tool
// call per turn) before it returns, so this group's timeout is sized for the whole loop rather than
// a single turn — generous relative to `synthesisActivities`' single-call budget above. A retried
// agentic loop re-spends real money the same way a retried `synthesizeAnswer` does, so this group
// keeps the same low `maximumAttempts` that group uses, for the same reason.
const agenticRetrievalActivities = proxyActivities<Pick<Activities, 'retrieveEvidenceAgentic'>>({
  startToCloseTimeout: '5 minutes',
  scheduleToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 2,
    // A missing tenantId never appears by retrying (`requireTenantId` in `activities.ts`). The
    // five model-spend/schema errors mirror `synthesisActivities` above, since every loop turn
    // makes the same kind of model call `synthesizeAnswer` does; `ModelBudgetExceededError` is
    // caught inside `gatherEvidence` itself and never actually propagates out of the activity, but
    // is listed here anyway as defence in depth against that catch ever being removed. The two
    // Voyage errors cover `search_evidence`, which calls `EvidenceRetrievalService.retrieve` (the
    // same Voyage-backed embedding call `retrievalActivities` above makes) on every tool
    // invocation, and are deterministic for a given input the same way they are there.
    nonRetryableErrorTypes: [
      'MissingTenantId',
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
      'VoyageApiKeyMissingError',
      'VoyageInvalidResponseError',
    ],
  },
});

/**
 * Second workflow in the tree (ADR-0003): retrieve → synthesize → verify grounding → persist.
 * Orchestration only — every side effect (the Mongo hybrid search, the model call, the
 * verification pass, the Mongo write) lives in an activity; this function just sequences their
 * results and threads `tenantId` through unopened to every activity that scopes on it
 * (`retrieveEvidence`/`retrieveEvidenceAgentic`, `synthesizeAnswer`, `groundingCheck`,
 * `persistAnswer`).
 */
export async function answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
  // Deterministic branch on `input` fields only — never on config, which would cross the
  // determinism fence (see `AnswerQuestionInput.retrievalStrategy`'s doc comment). Requiring
  // `actorId`/`role` alongside `retrievalStrategy` here, not just at the type level, is what keeps
  // a stale history recorded before any of the three fields existed on the same single-shot path a
  // history recorded before only `retrievalStrategy` existed takes.
  const chunks =
    input.retrievalStrategy === 'agentic' && input.actorId && input.role
      ? await agenticRetrievalActivities.retrieveEvidenceAgentic({
          questionText: input.questionText,
          tenantId: input.tenantId,
          actorId: input.actorId,
          role: input.role,
        })
      : await retrievalActivities.retrieveEvidence({
          questionText: input.questionText,
          tenantId: input.tenantId,
        });

  const { contract: outcome, usage } = await synthesisActivities.synthesizeAnswer({
    questionText: input.questionText,
    chunks,
    tenantId: input.tenantId,
  });

  const grounding = await groundingActivities.groundingCheck({
    outcome,
    retrievedChunks: chunks,
    tenantId: input.tenantId,
    questionText: input.questionText,
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
    usage,
  });

  return {
    answerId: persisted.answerId,
    outcomeKind: persisted.outcomeKind,
    claimCoverage: persisted.claimCoverage,
  };
}
