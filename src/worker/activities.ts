import type { INestApplicationContext } from '@nestjs/common';
import { DEFAULT_TENANT_ID } from '../database/constants/tenant.constant';
import {
  ConflictsService,
  type ConflictScanResult,
} from '../features/evidence/conflicts/conflicts.service';
import { FactsService, type FactsExtractionResult } from '../features/evidence/facts/facts.service';
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
import { SynthesisService } from '../features/evidence/qa/synthesis.service';
import type { RetrievedChunk } from '../features/evidence/qa/types/retrieved-chunk.type';
import type { GroundingCellFact } from '../features/evidence/qa/verify-claim';
import type { IngestDocumentVersionResult } from '../workflows/types';

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
  synthesizeAnswer(input: SynthesizeAnswerActivityInput): Promise<AnswerContract>;
  groundingCheck(input: GroundingCheckActivityInput): Promise<GroundingCheckActivityResult>;
  persistAnswer(input: PersistAnswerInput): Promise<PersistAnswerResult>;
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

  return {
    ingestDocumentVersion: (documentVersionId) => ingestionService.ingestVersion(documentVersionId),

    extractFacts: (documentVersionId) => factsService.extractFacts(documentVersionId),

    scanForConflicts: (tenantId) => conflictsService.scanForConflicts(tenantId),

    retrieveEvidence: (input) => evidenceRetrievalService.retrieve(input),

    synthesizeAnswer: (input) =>
      synthesisService.synthesizeAnswer({ question: input.questionText, chunks: input.chunks }),

    // `GroundingGateService.verify`'s input type only accepts the `answered` branch of
    // `AnswerContract` (see its own doc comment) — the model itself already said there was
    // nothing to cite for `insufficient_evidence`/`conflicting_evidence`, so there is nothing to
    // verify and the model's own outcome passes through unchanged. This branch, not the
    // workflow, is what decides that: the workflow calls `groundingCheck` unconditionally on
    // every run and never needs to know `AnswerContract`'s shape.
    //
    // For the `answered` branch, `report.outcomeKind` — not `input.outcome.kind` — decides what
    // gets returned as `outcome` (and, via `answer-question.workflow.ts`, what gets persisted).
    // "The model proposes, the application disposes": a model that claimed `answered` with every
    // citation later dropped must not have that claim persisted as-is (see ADR-0004's decision
    // section for the outcome-level degradation rule this mirrors). `cellFacts` and
    // `conflictedFactKeys` are both loaded here, scoped to `input.retrievedChunks` and
    // `input.tenantId` (never the tenant's whole `extracted_facts`/`conflicts` collections) — see
    // `FactsService.findCellFacts` and `ConflictsService.findConflictedFactGroupsForChunks` for
    // why that scoping is load-bearing, not just an optimization.
    groundingCheck: async (input) => {
      if (input.outcome.kind !== 'answered') {
        return { outcome: input.outcome, claims: [] };
      }

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
      if (report.outcomeKind === 'answered') {
        outcome = input.outcome;
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
      }

      return {
        outcome,
        claims: report.claims,
        claimCoverage: report.claimCoverage,
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
  };
}
