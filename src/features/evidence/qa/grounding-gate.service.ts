import { Injectable } from '@nestjs/common';
import type { FactKey } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { AnsweredOutcome, Claim, DroppedClaim } from './contracts/answer.contract';
import type { GroundingReport, GroundingViolation } from './types/grounding-report.type';
import type { RetrievedChunk } from './types/retrieved-chunk.type';
import { verifyClaim, type GroundingCellFact } from './verify-claim';

export interface VerifyGroundingInput {
  readonly outcome: AnsweredOutcome;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly cellFacts?: readonly GroundingCellFact[];
  readonly conflictedFactKeys?: readonly FactKey[];
}

/** Same grouping semantics as `groupKey` in `../conflicts/detect-conflicts.ts` (entity trimmed and
 * lowercased — free text an extractor read off a document; metric and period compared exactly —
 * already canonical). Reimplemented locally rather than imported: `src/features/evidence/conflicts/**`
 * is owned by another agent for this change, and this gate only needs key equality, not the rest of
 * that module's conflict-detection behavior. */
function factKeysMatch(a: FactKey, b: FactKey): boolean {
  return (
    a.entity.trim().toLowerCase() === b.entity.trim().toLowerCase() &&
    a.metric === b.metric &&
    a.period === b.period
  );
}

/**
 * The centrepiece verification gate: decides whether a model's claimed citations are real. It is a
 * VERIFICATION gate over untrusted model output, not a generator — it never calls a model, issues
 * no prompts, makes no HTTP or database calls, and it never adds a claim, a citation, or a fact the
 * model did not already produce. Its only power is to drop what it cannot verify.
 *
 * Fails CLOSED throughout: an unverifiable claim is dropped, never passed through with a warning
 * attached, because this is the one check standing between a hallucinated citation and a persisted
 * `Answer` a user reads as trustworthy.
 *
 * Runs the three checks (retrieval containment, quote containment, numeric-claim support) per claim
 * via `verifyClaim`, then applies outcome-level degradation:
 * - every claim survives → `answered`, full coverage.
 * - some survive → `answered`, reduced coverage, drops recorded.
 * - none survive → `insufficient_evidence` — a valid, correct success state, never an error.
 * - a surviving claim touches a fact key in `conflictedFactKeys` → forced `conflicting_evidence`,
 *   overriding every other outcome above, including a claim that verified perfectly on citation
 *   grounds — a well-cited answer that quietly picks one side of a known disagreement is the exact
 *   failure this gate exists to prevent.
 */
@Injectable()
export class GroundingGateService {
  constructor(private readonly logger: AppLogger) {
    this.logger.init(GroundingGateService.name);
  }

  verify(input: VerifyGroundingInput): GroundingReport {
    const cellFacts = input.cellFacts ?? [];
    const conflictedFactKeys = input.conflictedFactKeys ?? [];
    const totalClaims = input.outcome.claims.length;

    const survivingClaims: Claim[] = [];
    const droppedClaims: DroppedClaim[] = [];
    const violations: GroundingViolation[] = [];
    let conflictingFactKey: FactKey | undefined;

    for (const claim of input.outcome.claims) {
      const result = verifyClaim({ claim, retrievedChunks: input.retrievedChunks, cellFacts });
      violations.push(...result.violations);

      if (result.kind === 'dropped') {
        droppedClaims.push(result.dropped);
        this.logger.debug(`Dropped claim '${claim.statement}': ${result.dropped.reason}`);
        continue;
      }

      survivingClaims.push(result.claim);

      if (!conflictingFactKey) {
        conflictingFactKey = result.touchedFactKeys.find((touchedKey) =>
          conflictedFactKeys.some((conflicted) => factKeysMatch(touchedKey, conflicted)),
        );
      }
    }

    const claimCoverage = totalClaims === 0 ? 0 : survivingClaims.length / totalClaims;

    if (conflictingFactKey) {
      return {
        outcomeKind: 'conflicting_evidence',
        claims: survivingClaims,
        droppedClaims,
        violations,
        claimCoverage,
        conflictingFactKey,
      };
    }

    if (survivingClaims.length === 0) {
      return {
        outcomeKind: 'insufficient_evidence',
        claims: [],
        droppedClaims,
        violations,
        claimCoverage: 0,
      };
    }

    return {
      outcomeKind: 'answered',
      claims: survivingClaims,
      droppedClaims,
      violations,
      claimCoverage,
    };
  }
}
