/**
 * Argument/return contracts for `src/workflows/**`, kept independent of `IngestionResult`
 * (`src/features/evidence/ingestion/ingestion.service.ts`) even though the shape matches —
 * importing from a service file here, even `import type`, would defeat the point of this
 * directory being the one place the determinism fence (`eslint.config.mjs`, ADR-0003) polices.
 */
export interface IngestDocumentVersionInput {
  readonly documentVersionId: string;
}

export interface IngestDocumentVersionResult {
  readonly chunksCreated: number;
  readonly alreadyIngested: boolean;
}

/**
 * `tenantId` is optional here for the same reason `ConflictsService.scanForConflicts` defaults
 * it — single-tenant until multi-tenancy ships (`DEFAULT_TENANT_ID`). The workflow never imports
 * that constant (it would pull `src/database/**` into `src/workflows/**`); the default is applied
 * activity-side, in `EvidenceRetrievalService`/`AnswerPersistenceService`.
 *
 * `answerId` names the `queued` `Answer` row `QaService.startQuestion` already created before
 * starting this workflow — a plain string field, not a `mongoose`/`src/providers/**` import, so it
 * doesn't cross the determinism fence. `persistAnswer` updates that row rather than creating a
 * second one; see `AnswerPersistenceService`'s doc comment for the fail-closed behavior when it's
 * missing.
 */
export interface AnswerQuestionInput {
  readonly answerId: string;
  readonly questionText: string;
  readonly tenantId?: string;
}

/**
 * Deliberately a thin summary, not a mirror of `AnswerContract`/`GroundingReport`
 * (`src/features/evidence/qa/**`) — see this file's top-of-file comment. The full envelope is
 * persisted by `persistAnswer`; a caller that wants it back reads the `Answer` document by
 * `answerId`.
 */
export interface AnswerQuestionResult {
  readonly answerId: string;
  readonly outcomeKind: 'answered' | 'insufficient_evidence' | 'conflicting_evidence';
  readonly claimCoverage?: number;
}
