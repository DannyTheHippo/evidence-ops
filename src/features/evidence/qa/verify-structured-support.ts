import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import {
  findStatedPeriods,
  parsePeriodKey,
  periodsOverlap,
  type Period,
} from '../facts/derive-period';
import { chunkContainsSubjectEntity } from './entity-token-match';
import { containsUnrepresentableNumber } from './extract-numeric-tokens';
import {
  parseClaimAssertions,
  type ClaimAssertions,
  type NumericAssertion,
  type UnitKind,
} from './parse-claim-assertions';
import type { GroundingViolation } from './types/grounding-report.type';
import type { RetrievedChunk } from './types/retrieved-chunk.type';
import type { VerifierMeasure } from './types/verifier-measure.type';
import type { GroundingCellFact } from './verify-claim';

/**
 * Check 4's structured path: replaces digit-string matching with a claim number bound to a
 * confirmed measure, a cell fact's own canonical value, and (when stated) a period. Six rules, each
 * covered by its own tests:
 *
 * - **R1 binding** ({@link findBoundFact}): a cell fact supports a number only when its chunk is
 *   cited, its entity is a known claim subject, its metric is a candidate measure for that number,
 *   every period the claim states overlaps the fact's own period, and the two canonical values fall
 *   within the bound measure's tolerance.
 * - **R2 candidates** ({@link candidateMeasuresFor}): which measures a number can bind to at all.
 * - **R3 canonicalization** ({@link canonicalFactAmount}, {@link candidateCanonicalValues},
 *   {@link withinTolerance}): unit conversion, the percentage bare-number dual reading, and
 *   tolerance semantics.
 * - **R4 fallback** ({@link numberSupportedByRawText}): the asymmetric rule this module exists for
 *   — a number bound to a measure never falls back to a cited chunk's raw text once that chunk
 *   carries any cell fact at all, because a structured extraction is authoritative for that chunk
 *   and an unrelated digit elsewhere in it proves nothing; an unbound number has no structured
 *   ground truth to defer to and may still match raw text, on any cited chunk, cell-fact or not.
 * - **R5 periods** ({@link isPeriodSupported}): a stated period is supported by any cited,
 *   entity-bound fact carrying a matching period — regardless of whether that same fact also bound
 *   a number — or, on a chunk with no cell facts, by a period the chunk's own text states.
 * - **R6**: an unrepresentable number in the statement still drops the claim, independent of
 *   whether any of its representable numbers bind.
 *
 * With `subjectBinding` on, both fallbacks in R4, and R5's chunk-text fallback, additionally require
 * the cited chunk to name a subject entity whenever one is known — a chunk that never mentions the
 * claim's own subject is not evidence for it, however many digits it happens to repeat. Off (the
 * default), a chunk's raw text stands as its own evidence regardless of what it names, the same as
 * `verify-claim.ts`'s own `subjectBinding` gate defaults off for the equivalent citation-level check;
 * R1's fact binding above (`findBoundFact`'s `subjectEntities.has(...)` check) is unconditional
 * either way — a fact's entity is a structured field, not free text a chunk may simply omit.
 */

/**
 * Whether a claim number's unit family is compatible with a measure's declared `valueType`.
 * `currency`, `percentage`, `area` and `duration` only match their own name; `unknown` (a bare
 * quantity with no recognized unit word) is compatible with every `valueType`, since a bare number
 * carries no signature ruling any of them out.
 */
function unitKindCompatibleWithValueType(
  unitKind: UnitKind,
  valueType: VerifierMeasure['valueType'],
): boolean {
  if (unitKind === 'unknown') return true;
  return unitKind === valueType;
}

/**
 * The measures one numeric assertion can bind to. A typed number (currency/percentage/area/
 * duration) carries its own unit signature, so every confirmed measure of the matching `valueType`
 * is a candidate regardless of which measure the statement happens to name aloud — disambiguating
 * between two same-type measures is {@link findBoundFact}'s job (a candidate only actually binds
 * once its own fact's metric, entity, period and value all agree), not this function's. An
 * `'unknown'` number carries no unit signature at all, so it can only be a candidate for a measure
 * the statement explicitly names; with none named it has no candidate measure at all, which is the
 * state R4's raw-text fallback exists for.
 */
function candidateMeasuresFor(
  assertion: NumericAssertion,
  measures: readonly VerifierMeasure[],
  measureMentions: ReadonlySet<string>,
): readonly VerifierMeasure[] {
  if (assertion.unitKind === 'unknown') {
    return measures.filter((measure) => measureMentions.has(measure.slug));
  }
  return measures.filter((measure) =>
    unitKindCompatibleWithValueType(assertion.unitKind, measure.valueType),
  );
}

/**
 * `fact.value.amount` expressed in `measure.canonicalUnit`, or `undefined` when `fact.value.unit`
 * is not one of the units `measure` declares — such a fact carries a reading in a vocabulary this
 * measure never agreed to convert, so it supports nothing rather than being guessed at with an
 * assumed factor of 1.
 */
function canonicalFactAmount(
  fact: GroundingCellFact,
  measure: VerifierMeasure,
): number | undefined {
  const unit = measure.units.find((candidate) => candidate.id === fact.value.unit);
  return unit ? fact.value.amount * unit.toCanonicalFactor : undefined;
}

/**
 * Every canonical value a claim number should be compared against `measure` for — normally just
 * its own `canonicalValue`, plus a second reading at percentage scale (`value * 0.01`) when the
 * number carries no unit of its own and the candidate measure is itself a percentage: "the cap
 * rate is 4.55" written with no `%` sign is still worth checking against a `0.0455`-canonical
 * fact, deterministically, rather than only ever matching the literal digits `4.55`.
 */
function candidateCanonicalValues(
  assertion: NumericAssertion,
  measure: VerifierMeasure,
): readonly number[] {
  if (measure.valueType === 'percentage' && assertion.unitKind === 'unknown') {
    return [assertion.canonicalValue, assertion.value * 0.01];
  }
  return [assertion.canonicalValue];
}

/**
 * Whether `claimValue` and `factValue` — both already expressed in `measure.canonicalUnit` — are
 * close enough to count as the same reading, using `measure`'s own tolerance semantics: `absolute`
 * requires the raw difference within `tolerance`; `relative` requires it within `tolerance` times
 * the larger magnitude, so the same dollar gap reads as a match on a large deal and a conflict on a
 * small one.
 */
function withinTolerance(claimValue: number, factValue: number, measure: VerifierMeasure): boolean {
  const diff = Math.abs(claimValue - factValue);
  if (measure.toleranceKind === 'absolute') {
    return diff <= measure.tolerance;
  }
  return diff <= measure.tolerance * Math.max(Math.abs(claimValue), Math.abs(factValue));
}

/**
 * Whether `stated` names the same span of time as a fact's own `factPeriodKey`. Key equality is
 * checked first — the only route for a `fiscal-year` key, whose {@link parsePeriodKey} carries no
 * calendar range and therefore never overlaps anything via {@link periodsOverlap} — then calendar
 * overlap for every period with real bounds.
 */
function periodMatchesFactPeriod(stated: Period, factPeriodKey: string): boolean {
  return stated.key === factPeriodKey || periodsOverlap(stated, parsePeriodKey(factPeriodKey));
}

/** Whether a cited chunk is allowed to support a fallback at all: always, with `subjectBinding` off;
 * otherwise inert when no subject entity is known (`subjectEntities.size === 0`), and requiring the
 * chunk's own text to name one when one is known. */
function entityAllowsFallback(
  chunkText: string,
  subjectEntities: ReadonlySet<string>,
  subjectBinding: boolean,
): boolean {
  if (!subjectBinding) return true;
  return subjectEntities.size === 0 || chunkContainsSubjectEntity(chunkText, subjectEntities);
}

/**
 * R1: the first cited, entity-bound, metric-candidate, period-compatible cell fact whose canonical
 * value matches `assertion` within its measure's tolerance. A claim rarely has more than one real
 * candidate once entity and metric narrow the field, so no ranking beyond declaration order is
 * applied.
 */
function findBoundFact(
  assertion: NumericAssertion,
  candidates: readonly VerifierMeasure[],
  citedChunkIds: ReadonlySet<string>,
  cellFacts: readonly GroundingCellFact[],
  subjectEntities: ReadonlySet<string>,
  statedPeriods: readonly Period[],
): GroundingCellFact | undefined {
  return cellFacts.find((fact) => {
    if (!citedChunkIds.has(fact.chunkId)) return false;
    if (!subjectEntities.has(normalizeEntityName(fact.factKey.entity))) return false;
    const measure = candidates.find((candidate) => candidate.slug === fact.factKey.metric);
    if (!measure) return false;
    if (!statedPeriods.every((period) => periodMatchesFactPeriod(period, fact.factKey.period))) {
      return false;
    }
    const factCanonical = canonicalFactAmount(fact, measure);
    if (factCanonical === undefined) return false;
    return candidateCanonicalValues(assertion, measure).some((claimValue) =>
      withinTolerance(claimValue, factCanonical, measure),
    );
  });
}

/**
 * R4: whether an assertion with no bound fact is still supported by a cited chunk's raw text.
 * `measureBound` (a nonempty candidate list) is the asymmetry's whole hinge: once a chunk carries
 * any cell fact, a measure-bound number defers to it exclusively — never to raw text, cell-fact
 * chunk or otherwise — while an unbound number may still match raw text there, and on a chunk with
 * no cell facts at all a measure-bound number keeps the existing raw-text path (compared within
 * its candidate measures' tolerance rather than by exact equality).
 */
function numberSupportedByRawText(
  assertion: NumericAssertion,
  candidates: readonly VerifierMeasure[],
  citedChunks: readonly RetrievedChunk[],
  cellFacts: readonly GroundingCellFact[],
  measures: readonly VerifierMeasure[],
  subjectEntities: ReadonlySet<string>,
  subjectBinding: boolean,
): boolean {
  const measureBound = candidates.length > 0;
  return citedChunks.some((chunk) => {
    if (!entityAllowsFallback(chunk.text, subjectEntities, subjectBinding)) return false;
    const chunkHasCellFacts = cellFacts.some((fact) => fact.chunkId === chunk.chunkId);
    if (chunkHasCellFacts && measureBound) return false;

    const chunkNumbers = parseClaimAssertions({
      statement: chunk.text,
      measures,
      entities: [],
    }).numbers;
    if (candidates.length === 0) {
      return chunkNumbers.some((n) => n.canonicalValue === assertion.canonicalValue);
    }
    return chunkNumbers.some((n) =>
      candidates.some((measure) =>
        withinTolerance(n.canonicalValue, assertion.canonicalValue, measure),
      ),
    );
  });
}

/**
 * R5: whether `period` is supported — by any cited, entity-bound cell fact carrying a matching
 * period (any metric, not only one that also bound a number), or, on a cited chunk with no cell
 * facts at all, by a period that chunk's own text states.
 */
function isPeriodSupported(
  period: Period,
  citedChunkIds: ReadonlySet<string>,
  citedChunks: readonly RetrievedChunk[],
  cellFacts: readonly GroundingCellFact[],
  subjectEntities: ReadonlySet<string>,
  subjectBinding: boolean,
): boolean {
  const boundByFact = cellFacts.some(
    (fact) =>
      citedChunkIds.has(fact.chunkId) &&
      subjectEntities.has(normalizeEntityName(fact.factKey.entity)) &&
      periodMatchesFactPeriod(period, fact.factKey.period),
  );
  if (boundByFact) return true;

  return citedChunks.some((chunk) => {
    const chunkHasCellFacts = cellFacts.some((fact) => fact.chunkId === chunk.chunkId);
    if (chunkHasCellFacts || !entityAllowsFallback(chunk.text, subjectEntities, subjectBinding)) {
      return false;
    }
    return findStatedPeriods(chunk.text).some((chunkPeriod) =>
      periodMatchesFactPeriod(period, chunkPeriod.key),
    );
  });
}

/**
 * Verifies one claim statement's numbers and periods against cited evidence, per the module's own
 * doc comment. `supportingFacts` carries every fact a number actually bound to, for the caller's
 * locator upgrade and touched-fact-key bookkeeping — never a fact only reached through a raw-text
 * fallback, since a fallback match names no specific fact to upgrade a citation toward.
 */
export function verifyStructuredSupport(input: {
  readonly statement: string;
  readonly assertions: ClaimAssertions;
  readonly citedChunks: readonly RetrievedChunk[];
  readonly cellFacts: readonly GroundingCellFact[];
  readonly measures: readonly VerifierMeasure[];
  readonly subjectEntities: ReadonlySet<string>;
  /** Gates `entityAllowsFallback`'s chunk-text-mention requirement on R4's two raw-text fallbacks
   * and R5's chunk-text fallback; off by default, matching `verify-claim.ts`'s own citation-level
   * `subjectBinding` gate. R1's fact binding (`findBoundFact`, `isPeriodSupported`'s `boundByFact`)
   * is unconditional either way — `subjectEntities` itself, not this flag, controls that. */
  readonly subjectBinding?: boolean;
}): {
  readonly violations: readonly GroundingViolation[];
  readonly supportingFacts: readonly GroundingCellFact[];
} {
  const {
    statement,
    assertions,
    citedChunks,
    cellFacts,
    measures,
    subjectEntities,
    subjectBinding = false,
  } = input;
  const citedChunkIds = new Set(citedChunks.map((chunk) => chunk.chunkId));
  const violations: GroundingViolation[] = [];
  const supportingFacts: GroundingCellFact[] = [];

  // R6: a digit run this system cannot honestly represent drops the claim regardless of whether
  // every other, representable number in it binds — the same fail-closed direction check 4's
  // legacy path already took, now read off the masked statement rather than the raw one.
  if (containsUnrepresentableNumber(assertions.maskedStatement)) {
    violations.push({
      kind: 'numeric-claim-unsupported',
      claimStatement: statement,
      detail:
        'claim states a number this system cannot represent as a verifiable value (an unsupported digit script or a magnitude outside its safe range)',
    });
  }

  for (const assertion of assertions.numbers) {
    const candidates = candidateMeasuresFor(assertion, measures, assertions.measureMentions);
    const boundFact = findBoundFact(
      assertion,
      candidates,
      citedChunkIds,
      cellFacts,
      subjectEntities,
      assertions.periods,
    );

    if (boundFact) {
      supportingFacts.push(boundFact);
      continue;
    }

    const supported = numberSupportedByRawText(
      assertion,
      candidates,
      citedChunks,
      cellFacts,
      measures,
      subjectEntities,
      subjectBinding,
    );
    if (!supported) {
      violations.push({
        kind: 'numeric-claim-unsupported',
        claimStatement: statement,
        detail: `claim states the number ${assertion.canonicalValue}, which is not supported by any bound fact or eligible cited text`,
      });
    }
  }

  for (const period of assertions.periods) {
    const supported = isPeriodSupported(
      period,
      citedChunkIds,
      citedChunks,
      cellFacts,
      subjectEntities,
      subjectBinding,
    );
    if (!supported) {
      violations.push({
        kind: 'period-claim-unsupported',
        claimStatement: statement,
        detail: `claim states the period ${period.key}, which is not supported by any bound fact or eligible cited text`,
      });
    }
  }

  return { violations, supportingFacts };
}
