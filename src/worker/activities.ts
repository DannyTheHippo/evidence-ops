import type { INestApplicationContext } from '@nestjs/common';
import { DEFAULT_TENANT_ID } from '../database/constants/tenant.constant';
import {
  ConflictsService,
  type ConflictedFactGroup,
  type ConflictResolutionCandidate,
  type ConflictScanResult,
  type RecordConflictResolutionInput,
  type RecordConflictResolutionResult,
} from '../features/evidence/conflicts/conflicts.service';
import { FactsService, type FactsExtractionResult } from '../features/evidence/facts/facts.service';
import { extractNumericTokens } from '../features/evidence/qa/extract-numeric-tokens';
import { IngestionService } from '../features/evidence/ingestion/ingestion.service';
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
  readonly tenantId?: string;
}

export interface SynthesizeAnswerActivityInput {
  readonly questionText: string;
  readonly chunks: readonly RetrievedChunk[];
}

export interface GroundingCheckActivityInput {
  readonly outcome: AnswerContract;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly tenantId?: string;
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
  ingestDocumentVersion(documentVersionId: string): Promise<IngestDocumentVersionResult>;
  extractFacts(documentVersionId: string): Promise<FactsExtractionResult>;
  scanForConflicts(tenantId?: string): Promise<ConflictScanResult>;
  retrieveEvidence(input: RetrieveEvidenceInput): Promise<RetrievedChunk[]>;
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
  getApprovalDecision(approvalId: string, tenantId?: string): Promise<ApprovalResult>;
  recordConflictResolution(
    input: RecordConflictResolutionInput,
  ): Promise<RecordConflictResolutionResult>;
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
  const synthesisService = app.get(SynthesisService);
  const groundingGateService = app.get(GroundingGateService);
  const answerPersistenceService = app.get(AnswerPersistenceService);
  const approvalChannel = app.get<ApprovalChannel>(APPROVAL_CHANNEL);

  return {
    ingestDocumentVersion: (documentVersionId) => ingestionService.ingestVersion(documentVersionId),

    extractFacts: (documentVersionId) => factsService.extractFacts(documentVersionId),

    scanForConflicts: (tenantId) => conflictsService.scanForConflicts(tenantId),

    retrieveEvidence: (input) => evidenceRetrievalService.retrieve(input),

    synthesizeAnswer: (input) =>
      synthesisService.synthesizeAnswer({ question: input.questionText, chunks: input.chunks }),

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
    groundingCheck: async (input) => {
      if (input.outcome.kind === 'insufficient_evidence') {
        if (input.outcome.reasonCode === 'retrieved_evidence_contradicts_itself') {
          const chunkIds = input.retrievedChunks.map((chunk) => chunk.chunkId);
          const conflictGroups = await conflictsService.findConflictedFactGroupsForChunks(
            chunkIds,
            input.tenantId ?? DEFAULT_TENANT_ID,
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
        factsService.findCellFacts(chunkIds, input.tenantId ?? DEFAULT_TENANT_ID),
        conflictsService.findConflictedFactGroupsForChunks(
          chunkIds,
          input.tenantId ?? DEFAULT_TENANT_ID,
        ),
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
    },

    persistAnswer: (input) => answerPersistenceService.persist(input),

    loadConflict: (input) =>
      conflictsService.loadConflictForResolution(
        input.conflictId,
        input.winningFactId,
        input.tenantId,
      ),

    requestConflictApproval: (request) => approvalChannel.requestApproval(request),

    requestIngestApproval: (request) => approvalChannel.requestApproval(request),

    getApprovalDecision: (approvalId, tenantId) =>
      approvalChannel.getDecision(approvalId, tenantId),

    recordConflictResolution: (input) => conflictsService.recordResolution(input),
  };
}
