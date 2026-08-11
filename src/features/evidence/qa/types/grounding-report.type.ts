import type { FactKey } from '../../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { Claim, DroppedClaim } from '../contracts/answer.contract';

/**
 * Every way a claim's grounding can fail. `chunk-not-retrieved` is check 1 (retrieval containment
 * — a single `chunkId` lookup against the retrieved set; see `verifyClaim`'s doc comment on why
 * that lookup alone is now the whole check, `docVersionId`/`sha256` no longer being independent,
 * model-supplied fields to compare); `quote-not-found` and `quote-fuzzy-match` are check 2 (quote
 * containment) — kept as two kinds rather than one so a near-miss is diagnostically distinct from a
 * citation with no relationship to the chunk at all, even though both drop the claim identically;
 * `numeric-claim-unsupported` is check 3.
 */
export type GroundingViolationKind =
  'chunk-not-retrieved' | 'quote-not-found' | 'quote-fuzzy-match' | 'numeric-claim-unsupported';

export interface GroundingViolation {
  readonly kind: GroundingViolationKind;
  readonly claimStatement: string;
  readonly detail: string;
  readonly chunkId?: string;
}

/**
 * Narrower than `AnswerContract['kind']` on purpose: the gate can only ever *degrade* toward
 * `conflicting_evidence` by naming the fact key a surviving claim touched (see
 * `GroundingReport.conflictingFactKey`) — it has no access to the other conflicting values a
 * schema-valid `conflicting_evidence` outcome requires (`answer.contract.ts`'s
 * `conflictingEvidenceOutcomeSchema` needs >= 2 `values` with units and source chunks). Building
 * that full outcome is the synthesis step's job, using this report plus the `Conflict` collection
 * (`src/features/evidence/conflicts/**`, owned elsewhere).
 */
export type GroundingOutcomeKind = 'answered' | 'insufficient_evidence' | 'conflicting_evidence';

/**
 * The gate's complete, server-computed verdict. Every field here is derived from verification —
 * `claimCoverage`, in particular, can never be copied from the model (see `AnswerEnvelope`'s own
 * comment in `answer.contract.ts` for why that separation matters).
 */
export interface GroundingReport {
  readonly outcomeKind: GroundingOutcomeKind;
  /** Surviving claims, with any citation locator upgraded to a supporting cell-level fact
   * (check 3). Empty when `outcomeKind` is `insufficient_evidence`. */
  readonly claims: readonly Claim[];
  readonly droppedClaims: readonly DroppedClaim[];
  readonly violations: readonly GroundingViolation[];
  readonly claimCoverage: number;
  /** Set only when `outcomeKind === 'conflicting_evidence'`: the conflicted key a surviving claim
   * touched. */
  readonly conflictingFactKey?: FactKey;
}
