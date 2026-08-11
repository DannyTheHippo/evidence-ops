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

/**
 * `winningFactId` is not chosen inside `resolve-conflict.workflow.ts` — it travels in on `input`
 * from whichever caller started this workflow (D3, not built here), the same fields-not-imports
 * escape hatch `answerId` above uses: this workflow's only job is gating that proposal behind a
 * human, never inventing one. A plain string, not an ObjectId/mongoose import, for the same reason
 * `answerId` stays a plain string.
 */
export interface ResolveConflictWorkflowInput {
  readonly conflictId: string;
  readonly winningFactId: string;
  readonly requestedBy?: string;
  readonly tenantId?: string;
}

export type ResolveConflictOutcome = 'resolved' | 'rejected' | 'timed_out';

/**
 * Deliberately a thin summary, matching `AnswerQuestionResult`'s own "thin summary, not a mirror"
 * reasoning above — `winningFactId`/`winningValue`/`winningUnit` are only ever set alongside
 * `outcome: 'resolved'`; a caller wanting the full record (including a `rejected`/`timed_out`
 * attempt) reads the `Conflict` document by `conflictId`.
 */
export interface ResolveConflictWorkflowResult {
  readonly conflictId: string;
  readonly outcome: ResolveConflictOutcome;
  readonly winningFactId?: string;
  readonly winningValue?: number;
  readonly winningUnit?: string;
}

/**
 * Signal payload for `resolve-conflict.workflow.ts`'s wake-up signal. Deliberately inert: the
 * workflow's signal handler flips a wake-up flag and never reads `claimedDecision` (see the
 * workflow's own doc comment on why) — the field exists only so a caller can express intent to a
 * dashboard, and so a test can prove a payload that claims approval is ignored whenever the
 * persisted `Approval` row (read via `getApprovalDecision`) disagrees.
 */
export interface ResolveConflictApprovalSignal {
  readonly claimedDecision?: 'approved' | 'rejected';
}
