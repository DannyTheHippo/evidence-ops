import { Injectable } from '@nestjs/common';
import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { FactKey } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { groundingClaimsDroppedCounter } from '../../../providers/telemetry/domain-metrics';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { CanonicalEntityListing } from '../facts/canonical-entity.service';
import type { AnsweredOutcome, Claim, DroppedClaim } from './contracts/answer.contract';
import type { AtomizationSummary, ClaimAtoms } from './types/claim-atoms.type';
import type { GroundingReport, GroundingViolation } from './types/grounding-report.type';
import type { RetrievedChunk } from './types/retrieved-chunk.type';
import type { VerifierMeasure } from './types/verifier-measure.type';
import { verifyClaim, type GroundingCellFact } from './verify-claim';

export interface VerifyGroundingInput {
  readonly outcome: AnsweredOutcome;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly cellFacts?: readonly GroundingCellFact[];
  readonly conflictedFactKeys?: readonly FactKey[];
  /** Decomposed atoms per claim, keyed by the claim's index in `outcome.claims`. A claim with no
   * entry is verified as a whole statement only (`verifyClaim`'s `atoms` stays `undefined`). */
  readonly atomsByClaimIndex?: ReadonlyMap<number, readonly string[]>;
  /** Indexes (into `outcome.claims`) `ContradictionCheckService` found incompatible with their own
   * cited evidence. Applied only to a claim that already survived every other check — see `verify`'s
   * own doc comment on why an already-dropped claim is never named here twice. */
  readonly contradictedClaimIndexes?: ReadonlySet<number>;
  /** Confirmed measures, forwarded to `verifyClaim` for every claim. Omitted means check 4 stays
   * the legacy digit-matching loop for every claim. */
  readonly measures?: readonly VerifierMeasure[];
  /** Canonical entities, forwarded to `verifyClaim` for every claim. Only read when `measures` is
   * also supplied. */
  readonly entities?: readonly CanonicalEntityListing[];
}

/** Structural equality for `FactKey`. `entity` is free text an extractor read off a document, so it
 * is compared through `normalizeEntityName` — the same function `groupKey`
 * (`../conflicts/detect-conflicts.ts`) keys conflict grouping with, so a fact key this gate sees and
 * a fact key that grouping already grouped together compare equal here too. `metric` and `period`
 * are both already canonical (a metric id from the ontology, a period key from `parsePeriod`) and
 * compared exactly.
 *
 * Exact match only, never fuzzy: a name that does not fold to an identical normalized form does not
 * match, however similar it looks, because a fuzzy match here would fabricate a conflict between two
 * properties that were never the same — the same discipline `CanonicalEntity` enforces on its own
 * alias matching. A refused match is the permissive outcome at this function's only call site
 * (`verify`, below): it withholds the `conflicting_evidence` override, not a claim, so this
 * comparison's safety is identity with `groupKey`'s fold rather than a bias toward refusing.
 * Exported so `activities.ts` can look up which `ConflictedFactGroup` produced
 * `GroundingReport.conflictingFactKey` without reimplementing this comparison. */
export function factKeysMatch(a: FactKey, b: FactKey): boolean {
  return (
    normalizeEntityName(a.entity) === normalizeEntityName(b.entity) &&
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
 * Runs the four checks (retrieval containment, quote containment, quote alignment, numeric-claim
 * support) per claim via `verifyClaim` — passing `atomsByClaimIndex`, `measures` and `entities`
 * through per claim when the caller supplies them — then, for a claim that survived, applies
 * `contradictedClaimIndexes`: a survivor named there is dropped too, with a `claim-contradicted`
 * violation, before outcome-level degradation runs. `atomization` and `claimAtoms` on the returned
 * report summarize decomposition and contradiction across every claim, zeroed/empty when neither
 * input was supplied. Then applies outcome-level degradation:
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
    const claimAtoms: ClaimAtoms[] = [];
    let conflictingFactKey: FactKey | undefined;
    let decomposedClaimCount = 0;
    let coverageFallbackCount = 0;
    let atomDroppedClaimCount = 0;
    let contradictionDroppedClaimCount = 0;

    input.outcome.claims.forEach((claim, index) => {
      const atoms = input.atomsByClaimIndex?.get(index);
      const result = verifyClaim({
        claim,
        retrievedChunks: input.retrievedChunks,
        cellFacts,
        atoms,
        measures: input.measures,
        entities: input.entities,
      });
      violations.push(...result.violations);

      if (atoms !== undefined) {
        decomposedClaimCount += 1;
        if (result.atomization?.coverageFallback) coverageFallbackCount += 1;
        if (result.atomization?.atomDropped) atomDroppedClaimCount += 1;
      }

      if (result.kind === 'dropped') {
        droppedClaims.push(result.dropped);
        this.logger.debug(`Dropped claim '${claim.statement}': ${result.dropped.reason}`);
        // `result.violations[0].kind` — the bounded `GroundingViolationKind`, never
        // `result.dropped.reason` (free text quoting claim/chunk content, unsafe as a metric
        // attribute). `verifyClaim` never returns `kind: 'dropped'` with an empty `violations`.
        groundingClaimsDroppedCounter.add(1, { rule: result.violations[0].kind });
        return;
      }

      // Contradiction is applied only here, after every other check already let the claim
      // survive — a claim `verifyClaim` itself dropped is excluded by the `return` above and can
      // never also be dropped for contradiction, which would double-count it in
      // `contradictionDroppedClaimCount` and in `groundingClaimsDroppedCounter`.
      if (input.contradictedClaimIndexes?.has(index)) {
        const detail =
          'the contradiction check found the cited evidence incompatible with this claim';
        violations.push({ kind: 'claim-contradicted', claimStatement: claim.statement, detail });
        droppedClaims.push({ statement: claim.statement, reason: detail });
        this.logger.debug(`Dropped claim '${claim.statement}': ${detail}`);
        contradictionDroppedClaimCount += 1;
        groundingClaimsDroppedCounter.add(1, { rule: 'claim-contradicted' });
        return;
      }

      survivingClaims.push(result.claim);
      if (atoms !== undefined) {
        claimAtoms.push({ claimIndex: index, statement: claim.statement, atoms });
      }

      if (!conflictingFactKey) {
        conflictingFactKey = result.touchedFactKeys.find((touchedKey) =>
          conflictedFactKeys.some((conflicted) => factKeysMatch(touchedKey, conflicted)),
        );
      }
    });

    const claimCoverage = totalClaims === 0 ? 0 : survivingClaims.length / totalClaims;
    const atomization: AtomizationSummary = {
      decomposedClaimCount,
      coverageFallbackCount,
      atomDroppedClaimCount,
      contradictionDroppedClaimCount,
    };

    if (conflictingFactKey) {
      return {
        outcomeKind: 'conflicting_evidence',
        claims: survivingClaims,
        droppedClaims,
        violations,
        claimCoverage,
        conflictingFactKey,
        atomization,
        claimAtoms,
      };
    }

    if (survivingClaims.length === 0) {
      return {
        outcomeKind: 'insufficient_evidence',
        claims: [],
        droppedClaims,
        violations,
        claimCoverage: 0,
        atomization,
        claimAtoms,
      };
    }

    return {
      outcomeKind: 'answered',
      claims: survivingClaims,
      droppedClaims,
      violations,
      claimCoverage,
      atomization,
      claimAtoms,
    };
  }
}
