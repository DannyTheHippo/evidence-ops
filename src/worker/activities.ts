import type { INestApplicationContext } from '@nestjs/common';
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
import { GroundingGateService } from '../features/evidence/qa/grounding-gate.service';
import { SynthesisService } from '../features/evidence/qa/synthesis.service';
import type { RetrievedChunk } from '../features/evidence/qa/types/retrieved-chunk.type';
import type { IngestDocumentVersionResult } from '../workflows/types';

export interface SynthesizeAnswerActivityInput {
  readonly questionText: string;
  readonly chunks: readonly RetrievedChunk[];
}

export interface GroundingCheckActivityInput {
  readonly outcome: AnswerContract;
  readonly retrievedChunks: readonly RetrievedChunk[];
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
  const evidenceRetrievalService = app.get(EvidenceRetrievalService);
  const synthesisService = app.get(SynthesisService);
  const groundingGateService = app.get(GroundingGateService);
  const answerPersistenceService = app.get(AnswerPersistenceService);

  return {
    ingestDocumentVersion: (documentVersionId) => ingestionService.ingestVersion(documentVersionId),

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
    // section for the outcome-level degradation rule this mirrors). `conflictedFactKeys` is never
    // supplied here (this step doesn't wire `ConflictsService` — out of scope, recorded as a
    // known bound in ADR-0004), so `report.outcomeKind` can only actually come back `answered` or
    // `insufficient_evidence`; the `conflicting_evidence` branch below is an unreachable-branch
    // assertion, not a real path, until that wiring exists.
    // Stays a plain (non-`async`) arrow: nothing here awaits, so an `async` signature would trip
    // `@typescript-eslint/require-await`. The `conflicting_evidence` guard below returns a
    // `Promise.reject(...)` rather than `throw`ing, for the same reason — every call site treats
    // this as a promise-returning call, and a synchronous throw out of a non-`async` function
    // would not honor that.
    groundingCheck: (input) => {
      if (input.outcome.kind !== 'answered') {
        return Promise.resolve({ outcome: input.outcome, claims: [] });
      }

      const report = groundingGateService.verify({
        outcome: input.outcome,
        retrievedChunks: input.retrievedChunks,
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
      } else {
        return Promise.reject(
          new Error(
            "GroundingGateService returned 'conflicting_evidence', but conflictedFactKeys is " +
              'never supplied here so this branch should be unreachable; wire it together with ' +
              'ConflictsService (see ADR-0004 Known bounds) before removing this guard',
          ),
        );
      }

      return Promise.resolve({
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
      });
    },

    persistAnswer: (input) => answerPersistenceService.persist(input),
  };
}
