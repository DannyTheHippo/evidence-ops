import type { INestApplicationContext } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { Types } from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FactKey } from '../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  ConflictsService,
  type ConflictedFactGroup,
  type ConflictResolutionCandidate,
  type ConflictScanResult,
  type RecordConflictResolutionInput,
  type RecordConflictResolutionResult,
} from '../features/evidence/conflicts/conflicts.service';
import { FactsService, type FactsExtractionResult } from '../features/evidence/facts/facts.service';
import { AgenticRetrievalService } from '../features/evidence/qa/agentic-retrieval.service';
import { extractNumericTokens } from '../features/evidence/qa/extract-numeric-tokens';
import { IngestionService } from '../features/evidence/ingestion/ingestion.service';
import { SourcesService, type RunSyncResult } from '../features/evidence/sources/sources.service';
import {
  AnswerPersistenceService,
  type PersistAnswerInput,
  type PersistAnswerResult,
} from '../features/evidence/qa/answer-persistence.service';
import type {
  AnswerContract,
  Claim,
  VerificationReport,
} from '../features/evidence/qa/contracts/answer.contract';
import {
  EvidenceRetrievalService,
  type RetrieveEvidenceInput,
} from '../features/evidence/qa/evidence-retrieval.service';
import {
  factKeysMatch,
  GroundingGateService,
} from '../features/evidence/qa/grounding-gate.service';
import {
  SynthesisService,
  type SynthesizeAnswerResult,
} from '../features/evidence/qa/synthesis.service';
import type { RetrievedChunk } from '../features/evidence/qa/types/retrieved-chunk.type';
import type { GroundingCellFact } from '../features/evidence/qa/verify-claim';
import {
  APPROVAL_CHANNEL,
  type ApprovalChannel,
  type ApprovalHandle,
  type ApprovalRequest,
  type ApprovalResult,
} from '../providers/approval-channel/approval-channel.interface';
import { UserRole } from '../shared/enums/user-role.enum';
import type { AlsContext } from '../shared/types/als-context.type';
import type { IngestDocumentVersionResult } from '../workflows/types';

/**
 * Widens conflict forcing to the prose side of ADR-0004 bound 3, which `GroundingGateService`
 * itself only ever computes from `cellFacts` — deliberately `xlsx-cell`-only (see
 * `FactsService.findCellFacts`'s doc comment). That narrowness is load-bearing there: `cellFacts`
 * doubles as the gate's numeric-support authority signal (bound 2), and widening it to every
 * locator kind would make any prose chunk with even one extracted fact "authoritative", rejecting
 * a claim's other numbers that structured (model-based, incomplete) prose extraction simply never
 * captured. So this check runs independently, here, over `conflictGroups` already loaded for this
 * request (never a second query) — reusing the exact value-matched, per-claim-citation discipline
 * bound 3 established: a claim forces `conflicting_evidence` only when it states a number that is
 * itself one of a known conflict's values, sourced from a chunk that claim's own citations name —
 * never merely because the claim cites a chunk that also happens to hold an unrelated conflicted
 * fact. Inherits bound 3's known remainders for the same reason the gate's own check does: a claim
 * stating a conflicted value in words ("six percent") is invisible to `extractNumericTokens`, and
 * two distinct facts sharing the exact same `value` on the same cited chunk would still cross-touch.
 */
function findEitherSideConflict(
  claims: readonly Claim[],
  conflictGroups: readonly ConflictedFactGroup[],
): ConflictedFactGroup | undefined {
  for (const claim of claims) {
    const citedChunkIds = new Set(claim.citations.map((citation) => citation.chunkId));
    const claimedNumbers = extractNumericTokens(claim.statement);
    const match = conflictGroups.find((group) =>
      group.values.some(
        (value) => citedChunkIds.has(value.sourceChunkId) && claimedNumbers.includes(value.value),
      ),
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}

export interface LoadConflictActivityInput {
  readonly conflictId: string;
  readonly winningFactId: string;
  readonly tenantId: string;
}

/**
 * `actorId`/`role` are the workflow's own plain-field carry of the caller's identity
 * (`AnswerQuestionInput`'s own doc comment) — this activity is the one place that turns them into
 * the server-derived `ToolExecutionContext` `AgenticRetrievalService.gatherEvidence`'s tool calls
 * need. `role` stays a plain string union here, matching `AnswerQuestionInput.role`, and is mapped
 * to `UserRole` only inside `createActivities` below, never in the interface itself.
 */
export interface RetrieveEvidenceAgenticActivityInput {
  readonly questionText: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly role: 'admin' | 'member';
}

export interface SynthesizeAnswerActivityInput {
  readonly questionText: string;
  readonly chunks: readonly RetrievedChunk[];
  readonly tenantId: string;
}

export interface GroundingCheckActivityInput {
  readonly outcome: AnswerContract;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly tenantId: string;
}

export interface GroundingCheckActivityResult {
  /** The gate-verified outcome, never the model's raw claim: when `GroundingGateService.verify`
   * degrades (e.g. every claim dropped → `insufficient_evidence`), this is the degraded outcome,
   * not `input.outcome`. Always present, including on the non-`answered` early-return branch
   * below, where the model's own outcome passes through unchanged because there was nothing to
   * verify. */
  readonly outcome: AnswerContract;
  readonly claims: readonly Claim[];
  readonly claimCoverage?: number;
  readonly verificationReport?: VerificationReport;
  /** The `Conflict._id`(s) that caused `outcome.kind === 'conflicting_evidence'` — absent
   * whenever `outcome` is not that kind. Threaded through to `Answer.conflictIds` by
   * `answer-question.workflow.ts` so a conflicting-evidence answer names the record(s) that
   * produced it, not just their values. */
  readonly conflictIds?: readonly string[];
}

/**
 * Activity function signatures. Workflow code imports this interface `import type` only (see
 * `src/workflows/ingest-document-version.workflow.ts`) so the type-erasure boundary is explicit:
 * a workflow file that switched to a value import of this module would pull `@nestjs/common` and
 * every service below (and, transitively, mongoose) into the workflow bundle — exactly what the
 * bundler half of the determinism fence exists to reject (ADR-0003).
 */
export interface Activities {
  ingestDocumentVersion(
    documentVersionId: string,
    tenantId: string,
  ): Promise<IngestDocumentVersionResult>;
  extractFacts(documentVersionId: string, tenantId: string): Promise<FactsExtractionResult>;
  scanForConflicts(tenantId: string, factKeys?: readonly FactKey[]): Promise<ConflictScanResult>;
  retrieveEvidence(input: RetrieveEvidenceInput): Promise<RetrievedChunk[]>;
  // Same return shape as `retrieveEvidence` above — `GatherEvidenceResult`'s `iterations`,
  // `costUsd`, and `terminationReason` are logged service-side (`AgenticRetrievalService
  // .gatherEvidence`'s own debug line) and discarded here, not threaded through, so
  // `synthesizeAnswer` below consumes an identical `RetrievedChunk[]` regardless of which
  // retrieval activity produced it.
  retrieveEvidenceAgentic(input: RetrieveEvidenceAgenticActivityInput): Promise<RetrievedChunk[]>;
  synthesizeAnswer(input: SynthesizeAnswerActivityInput): Promise<SynthesizeAnswerResult>;
  groundingCheck(input: GroundingCheckActivityInput): Promise<GroundingCheckActivityResult>;
  persistAnswer(input: PersistAnswerInput): Promise<PersistAnswerResult>;
  loadConflict(input: LoadConflictActivityInput): Promise<ConflictResolutionCandidate>;
  requestConflictApproval(request: ApprovalRequest): Promise<ApprovalHandle>;
  // Same underlying `ApprovalChannel.requestApproval` call as `requestConflictApproval` above —
  // kept as its own named activity, not a shared generic one, matching the one-activity-per-
  // calling-workflow convention every other activity in this interface follows (`loadConflict`,
  // `recordConflictResolution`), so each workflow's `proxyActivities` group names exactly the
  // calls it makes rather than a name that says "conflict" to a caller that isn't one.
  requestIngestApproval(request: ApprovalRequest): Promise<ApprovalHandle>;
  getApprovalDecision(approvalId: string, tenantId: string): Promise<ApprovalResult>;
  recordConflictResolution(
    input: RecordConflictResolutionInput,
  ): Promise<RecordConflictResolutionResult>;
  /** `sourceId` only — mints a fresh `leaseToken` here, activity-side, on every call, since a
   * Temporal retry of this exact activity reuses the identical input and could never distinguish a
   * stale attempt from a newer one with a token threaded through the workflow instead (see
   * `SourcesService.runSync`'s own doc comment). */
  runSourceSync(sourceId: string): Promise<RunSyncResult>;
}

/**
 * FAILS CLOSED: rejects a missing/empty `tenantId` rather than letting an activity run with one
 * unset. Every `Activities` signature already types `tenantId: string`, but that only binds new
 * workflow executions — Temporal replays histories started before this deploy, and a history
 * recorded before the tenant requirement existed supplies no `tenantId` at all, type or no type.
 * Non-retryable: a history that never had a tenant can never acquire one, so retrying would only
 * burn the activity's retry budget reaching the same failure.
 */
function requireTenantId(tenantId: string | undefined | null): string {
  if (!tenantId) {
    throw ApplicationFailure.nonRetryable(
      'Activity received no tenantId; a stale workflow history predates the tenant requirement ' +
        'and can never acquire one by retrying',
      'MissingTenantId',
    );
  }
  return tenantId;
}

/**
 * Restores `tenantScopePlugin`'s structural backstop (`src/database/plugins/tenant-scope.plugin.ts`)
 * for activity code. That plugin reads the tenant from AsyncLocalStorage and no-ops outside a
 * request; an activity runs with no request to inherit a store from, so without this every
 * Mongoose query `fn` awaits bypasses the backstop entirely. Running `fn` inside a fresh scope
 * carrying `tenantId` gives it back. This is defence in depth, layered on top of — never a
 * substitute for — the explicit `tenantId` predicate every tenant-scoped service call already
 * carries; nothing here removes or loosens one of those.
 *
 * `fn` must `await` its work before returning, not merely construct a query and hand it off: a
 * Mongoose query built inside this scope but awaited after it exits runs unscoped (the same
 * laziness caveat `tenantScopePlugin`'s own doc comment documents).
 *
 * `async` rather than a plain function returning `als.run(...)` directly: every activity in
 * `Activities` types as returning a `Promise`, and a caller reasonably relies on that — a plain
 * function would let `requireTenantId`'s rejection throw synchronously out of the call instead of
 * arriving as a rejected promise like every other failure this activity can produce.
 */
async function withTenantScope<T>(
  als: AsyncLocalStorage<AlsContext>,
  tenantId: string | undefined | null,
  fn: () => Promise<T>,
): Promise<T> {
  const tenant = requireTenantId(tenantId);
  return als.run({ 'correlation-id': randomUUID(), tenant }, fn);
}

/**
 * Activities are thin closures over services resolved from the worker's own Nest application
 * context (`worker.module.ts`, booted in `main.ts`) — the same DI graph the API process uses, per
 * ADR-0003's "Wiring to NestJS" section. All non-deterministic work (the Mongo reads/writes,
 * model calls, parsing, embedding) lives here, never in workflow code.
 */
export function createActivities(app: INestApplicationContext): Activities {
  const ingestionService = app.get(IngestionService);
  const factsService = app.get(FactsService);
  const conflictsService = app.get(ConflictsService);
  const evidenceRetrievalService = app.get(EvidenceRetrievalService);
  const agenticRetrievalService = app.get(AgenticRetrievalService);
  const synthesisService = app.get(SynthesisService);
  const groundingGateService = app.get(GroundingGateService);
  const answerPersistenceService = app.get(AnswerPersistenceService);
  const approvalChannel = app.get<ApprovalChannel>(APPROVAL_CHANNEL);
  const sourcesService = app.get(SourcesService);
  const als = app.get<AsyncLocalStorage<AlsContext>>(AsyncLocalStorage);

  return {
    ingestDocumentVersion: (documentVersionId, tenantId) =>
      withTenantScope(als, tenantId, () =>
        ingestionService.ingestVersion(documentVersionId, tenantId),
      ),

    extractFacts: (documentVersionId, tenantId) =>
      withTenantScope(als, tenantId, () => factsService.extractFacts(documentVersionId, tenantId)),

    scanForConflicts: (tenantId, factKeys) =>
      withTenantScope(als, tenantId, () => conflictsService.scanForConflicts(tenantId, factKeys)),

    retrieveEvidence: (input) =>
      withTenantScope(als, input.tenantId, () => evidenceRetrievalService.retrieve(input)),

    retrieveEvidenceAgentic: (input) =>
      withTenantScope(als, input.tenantId, async () => {
        const result = await agenticRetrievalService.gatherEvidence({
          questionText: input.questionText,
          context: {
            tenantId: input.tenantId,
            actorId: input.actorId,
            // `role` crosses back from `AnswerQuestionInput`'s plain-union carry to the real
            // `UserRole` enum `ToolExecutionContext` declares — the workflow-side type stays a
            // plain union so it never imports the enum across the determinism fence.
            role: input.role as UserRole,
          },
        });
        return [...result.chunks];
      }),

    synthesizeAnswer: (input) =>
      synthesisService.synthesizeAnswer({
        question: input.questionText,
        chunks: input.chunks,
        tenantId: input.tenantId,
      }),

    // `GroundingGateService.verify`'s input type only accepts the `answered` branch of
    // `AnswerContract` (see its own doc comment) — the model itself already said there was
    // nothing to cite for `conflicting_evidence` (unreachable from a real model call — see
    // `modelAnswerContractSchema`'s doc comment — kept here only as a fail-closed pass-through for
    // a shape `AnswerContract`'s type allows), so there is nothing to verify and the model's own
    // outcome passes through unchanged.
    //
    // `insufficient_evidence` gets its own branch below: "model hints, server verifies". The model
    // can flag a self-noticed contradiction only via `reasonCode: 'retrieved_evidence_contradicts_itself'`
    // (`conflicting_evidence` was deliberately removed from the model-facing schema — ADR-0004
    // bound 4/5) — that code is a HINT, never the verdict. FAILS CLOSED: absent an independently
    // verified open conflict among the retrieved chunks' own facts, the abstention is returned
    // unchanged, regardless of what the model claimed. `reasonCode` itself is safe to branch on
    // even from an unvalidated `ModelProvider` — `SynthesisService.resolveContract` already drops
    // any value outside the three closed literals (`resolveReasonCode`) before this ever runs, so
    // a bogus/injected code just never matches this literal and falls through to "unchanged".
    groundingCheck: (input) =>
      withTenantScope(als, input.tenantId, async () => {
        if (input.outcome.kind === 'insufficient_evidence') {
          if (input.outcome.reasonCode === 'retrieved_evidence_contradicts_itself') {
            const chunkIds = input.retrievedChunks.map((chunk) => chunk.chunkId);
            const conflictGroups = await conflictsService.findConflictedFactGroupsForChunks(
              chunkIds,
              input.tenantId,
            );
            // First open conflict touched by the retrieved evidence, same deterministic first-match
            // convention `GroundingGateService.verify` uses for the `answered` branch below — there is
            // no per-claim citation to narrow the choice by here (the model abstained, so there are no
            // claims at all), only the retrieval scope itself.
            const [firstGroup] = conflictGroups;
            if (firstGroup) {
              return {
                outcome: {
                  kind: 'conflicting_evidence',
                  factKey: firstGroup.factKey,
                  // `AnswerContract`'s `values` (mutable, zod-inferred) doesn't accept
                  // `ConflictedFactGroup.values`'s `readonly ConflictedFactValue[]` directly.
                  values: [...firstGroup.values],
                },
                claims: [],
                conflictIds: [firstGroup.conflictId],
              };
            }
          }
          return { outcome: input.outcome, claims: [] };
        }

        if (input.outcome.kind !== 'answered') {
          return { outcome: input.outcome, claims: [] };
        }

        // For the `answered` branch, `report.outcomeKind` — not `input.outcome.kind` — decides what
        // gets returned as `outcome` (and, via `answer-question.workflow.ts`, what gets persisted).
        // "The model proposes, the application disposes": a model that claimed `answered` with every
        // citation later dropped must not have that claim persisted as-is (see ADR-0004's decision
        // section for the outcome-level degradation rule this mirrors). `cellFacts` and
        // `conflictedFactKeys` are both loaded here, scoped to `input.retrievedChunks` and
        // `input.tenantId` (never the tenant's whole `extracted_facts`/`conflicts` collections) — see
        // `FactsService.findCellFacts` and `ConflictsService.findConflictedFactGroupsForChunks` for
        // why that scoping is load-bearing, not just an optimization.
        const chunkIds = input.retrievedChunks.map((chunk) => chunk.chunkId);
        const [cellFactDocs, conflictGroups] = await Promise.all([
          factsService.findCellFacts(chunkIds, input.tenantId),
          conflictsService.findConflictedFactGroupsForChunks(chunkIds, input.tenantId),
        ]);

        const cellFacts: GroundingCellFact[] = cellFactDocs.map((fact) => ({
          chunkId: fact.chunkId,
          factKey: {
            entity: fact.factKey.entity,
            metric: fact.factKey.metric,
            period: fact.factKey.period,
          },
          value: { amount: fact.value.amount, unit: fact.value.unit },
          locator: fact.locator,
        }));

        const report = groundingGateService.verify({
          outcome: input.outcome,
          retrievedChunks: input.retrievedChunks,
          cellFacts,
          conflictedFactKeys: conflictGroups.map((group) => group.factKey),
        });
        const totalClaimCount = report.claims.length + report.droppedClaims.length;

        let outcome: AnswerContract;
        // Set alongside `outcome` in whichever branch below forces `conflicting_evidence` — absent
        // (never `[]`) on every other branch, matching `GroundingCheckActivityResult.conflictIds`'s
        // own "absent whenever outcome is not that kind" contract.
        let conflictIds: readonly string[] | undefined;
        if (report.outcomeKind === 'answered') {
          // Either-side widening (ADR-0004, "SUB-DECISION"): the gate's own forcing above only ever
          // fires from `cellFacts`, deliberately `xlsx-cell`-only — see `findEitherSideConflict`'s
          // doc comment for why that stays narrow and this check runs here instead, over the same
          // `conflictGroups` already loaded, rather than widening the gate's own input.
          const eitherSideMatch = findEitherSideConflict(report.claims, conflictGroups);
          if (eitherSideMatch) {
            outcome = {
              kind: 'conflicting_evidence',
              factKey: eitherSideMatch.factKey,
              values: [...eitherSideMatch.values],
            };
            conflictIds = [eitherSideMatch.conflictId];
          } else {
            outcome = input.outcome;
          }
        } else if (report.outcomeKind === 'insufficient_evidence') {
          outcome = {
            kind: 'insufficient_evidence',
            reason: `grounding gate verified 0 of ${totalClaimCount} claim(s); every citation failed verification`,
          };
        } else if (!report.conflictingFactKey) {
          // `GroundingReport.outcomeKind`/`conflictingFactKey` aren't a discriminated union, so `tsc`
          // can't narrow this on its own — `GroundingGateService.verify` only ever returns
          // `outcomeKind: 'conflicting_evidence'` alongside a set `conflictingFactKey` (see its own
          // implementation), so this is an invariant violation, not a normal branch.
          throw new Error(
            "GroundingGateService returned outcomeKind 'conflicting_evidence' with no " +
              'conflictingFactKey set',
          );
        } else {
          // Captured into a local rather than read as `report.conflictingFactKey` inside the closure
          // below: `tsc` doesn't carry the `else if (!report.conflictingFactKey)` narrowing above
          // through a callback passed to `.find()`.
          const conflictingFactKey = report.conflictingFactKey;
          // `conflictingFactKey` is always one of `conflictGroups`' keys (`verify` can only ever
          // have matched it against an entry from `conflictedFactKeys`, which came from
          // `conflictGroups` above) — `factKeysMatch`, not `===`/deep-equal, because the touched key
          // is the fact's own (free-text, differently-cased) key, not the conflict's canonical one.
          const matchedGroup = conflictGroups.find((group) =>
            factKeysMatch(group.factKey, conflictingFactKey),
          );
          if (!matchedGroup) {
            // Invariant violation, not a normal branch: `conflictedFactKeys` supplied to `verify`
            // above came entirely from `conflictGroups`, so a returned `conflictingFactKey` with no
            // matching group means the gate and this lookup have drifted out of sync.
            throw new Error(
              `GroundingGateService returned 'conflicting_evidence' for a fact key with no ` +
                'matching entry in conflictGroups; conflictedFactKeys and the group lookup have ' +
                'drifted out of sync',
            );
          }
          outcome = {
            kind: 'conflicting_evidence',
            factKey: matchedGroup.factKey,
            // `AnswerContract`'s `values` (mutable, zod-inferred) doesn't accept
            // `ConflictedFactGroup.values`'s `readonly ConflictedFactValue[]` directly.
            values: [...matchedGroup.values],
          };
          conflictIds = [matchedGroup.conflictId];
        }

        return {
          outcome,
          claims: report.claims,
          claimCoverage: report.claimCoverage,
          conflictIds,
          verificationReport: {
            verifiedClaimCount: report.claims.length,
            totalClaimCount,
            // `VerificationReport.droppedClaims` (mutable) doesn't accept `GroundingReport`'s
            // `readonly DroppedClaim[]` directly.
            droppedClaims: [...report.droppedClaims],
          },
        };
      }),

    persistAnswer: (input) =>
      withTenantScope(als, input.tenantId, () => answerPersistenceService.persist(input)),

    loadConflict: (input) =>
      withTenantScope(als, input.tenantId, () =>
        conflictsService.loadConflictForResolution(
          input.conflictId,
          input.winningFactId,
          input.tenantId,
        ),
      ),

    requestConflictApproval: (request) =>
      withTenantScope(als, request.tenantId, () => approvalChannel.requestApproval(request)),

    requestIngestApproval: (request) =>
      withTenantScope(als, request.tenantId, () => approvalChannel.requestApproval(request)),

    getApprovalDecision: (approvalId, tenantId) =>
      withTenantScope(als, tenantId, () => approvalChannel.getDecision(approvalId, tenantId)),

    recordConflictResolution: (input) =>
      withTenantScope(als, input.tenantId, () => conflictsService.recordResolution(input)),

    runSourceSync: (sourceId) => sourcesService.runSync(sourceId, new Types.ObjectId()),
  };
}
