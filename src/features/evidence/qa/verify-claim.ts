import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  FactKey,
  FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { locateQuote } from '../../../shared/utils/locate-quote.util';
import { checkQuoteAlignment } from './check-quote-alignment';
import type { Citation, Claim, DroppedClaim } from './contracts/answer.contract';
import { chunkContainsSubjectEntity, containsNormalizedToken } from './entity-token-match';
import type { CanonicalEntityListing } from '../facts/canonical-entity.service';
import { containsUnrepresentableNumber, extractNumericTokens } from './extract-numeric-tokens';
import { findMetricById, METRIC_ONTOLOGY } from '../facts/metric-ontology';
import { parseClaimAssertions } from './parse-claim-assertions';
import type { RetrievedChunk } from './types/retrieved-chunk.type';
import type { VerifierMeasure } from './types/verifier-measure.type';
import type { GroundingViolation } from './types/grounding-report.type';
import { verifyAtoms } from './verify-atoms';
import { verifyStructuredSupport } from './verify-structured-support';

/** Re-exported so existing importers (`claim-verification.service.ts` and others) keep compiling
 * without reaching into `entity-token-match.ts` directly. */
export { containsNormalizedToken };

/**
 * The entities `subjectBinding` treats this claim as being about: every `cellFacts[].factKey.entity`
 * whose {@link normalizeEntityName} form is a whole-token match inside the claim's own (equally
 * normalized) statement. `Claim` carries no structured subject field of its own and this module has
 * no registry access to resolve one — this is the only entity signal available without trusting a
 * second, model-authored source of truth. A claim whose statement names none of the retrieved facts'
 * entities yields an empty set, and every `subjectBinding` check below is deliberately inert for it —
 * a claim about an entity with no extracted facts must not be rejected for "having no subject". Also
 * the entity signal `verifyStatement`'s structured check 4 uses to seed `verifyStructuredSupport`'s
 * `subjectEntities`, independent of whether `subjectBinding` itself is on.
 */
function collectSubjectEntities(
  normalizedStatement: string,
  cellFacts: readonly GroundingCellFact[],
): ReadonlySet<string> {
  const entities = new Set<string>();
  for (const fact of cellFacts) {
    const normalizedEntity = normalizeEntityName(fact.factKey.entity);
    if (containsNormalizedToken(normalizedStatement, normalizedEntity)) {
      entities.add(normalizedEntity);
    }
  }
  return entities;
}

/**
 * Whether `metricId` (a `GroundingCellFact.factKey.metric`) is one the claim's statement could
 * plausibly be about. Matched by label/alias containment against `measures` when supplied, or
 * against `METRIC_ONTOLOGY` (`metric-ontology.ts`, the same closed id space fact extraction is
 * constrained to) otherwise — rather than the ontology's own `findMetricByAlias` exact-equality
 * lookup, since a claim statement is prose, not a spreadsheet column header. A `metricId` absent
 * from the chosen source relates to nothing: fails closed rather than matching vacuously.
 */
function metricRelatesToClaim(
  metricId: string,
  normalizedStatement: string,
  measures?: readonly VerifierMeasure[],
): boolean {
  const metric = measures
    ? measures.find((candidate) => candidate.slug === metricId)
    : findMetricById(METRIC_ONTOLOGY, metricId);
  if (!metric) return false;
  return [metric.label, ...metric.aliases].some((phrase) =>
    containsNormalizedToken(normalizedStatement, normalizeEntityName(phrase)),
  );
}

/**
 * Whether `unit` is one `metricId`'s entry (from `measures` when supplied, `METRIC_ONTOLOGY`
 * otherwise) actually declares — catches a fact whose `value.unit` belongs to a different metric's
 * unit vocabulary entirely (e.g. `sf` on a `cap_rate` fact), which bare value equality has no way to
 * notice. A `metricId` absent from the chosen source has no declared units, so nothing validates
 * against it.
 */
function unitValidForMetric(
  metricId: string,
  unit: string,
  measures?: readonly VerifierMeasure[],
): boolean {
  const metric = measures
    ? measures.find((candidate) => candidate.slug === metricId)
    : findMetricById(METRIC_ONTOLOGY, metricId);
  return metric?.units.some((candidate) => candidate.id === unit) ?? false;
}

/** Check 4's `subjectBinding` gate: a value-matched fact only counts as support once its entity is
 * one the claim's statement actually names, its metric is one the statement could plausibly be
 * about, and its unit belongs to that metric's own vocabulary — closing the gap where two distinct
 * facts on the same cited chunk carry the identical `value.amount` (see `docs/adr/
 * 0004-grounding-gate-and-citation-contract.md` bound 3's "what remains, honestly"). */
function isFactBoundToClaim(
  fact: GroundingCellFact,
  normalizedStatement: string,
  subjectEntities: ReadonlySet<string>,
): boolean {
  return (
    subjectEntities.has(normalizeEntityName(fact.factKey.entity)) &&
    metricRelatesToClaim(fact.factKey.metric, normalizedStatement) &&
    unitValidForMetric(fact.factKey.metric, fact.value.unit)
  );
}

/**
 * A cell-level (or otherwise narrower-than-chunk) fact available to support a numeric claim.
 * Deliberately a plain-data shape, not the Mongoose `ExtractedFact` schema class — the same choice
 * `detect-conflicts.ts` makes with `FactForConflictScan`: this module has no Mongoose dependency
 * and stays testable with plain object literals. The caller (a later synthesis step, DB-aware)
 * projects `ExtractedFactDocument`s into this shape, using `chunkId.toString()`.
 */
export interface GroundingCellFact {
  readonly chunkId: string;
  readonly factKey: FactKey;
  readonly value: FactValue;
  readonly locator: EvidenceLocator;
}

/** Fact keys of every `cellFacts` entry the claim actually rests on — the same value-matched
 * facts check 4 finds while verifying numeric support, not every fact sharing a cited chunk.
 * Chunk-grain touching (bound 3, `docs/adr/0004-grounding-gate-and-citation-contract.md`) forced
 * `conflicting_evidence` on any claim citing a chunk that merely *contained* a conflicted cell
 * anywhere in it — a comps-sheet claim about one property inherited every other property's
 * conflicts because a spreadsheet's row-window chunk holds many properties' facts at once. Value
 * matching narrows "touches" to "asserts a number this specific fact records", so a claim about
 * Cedar Bluff's building area no longer touches Northgate's cap-rate fact just because both live
 * in the same chunk. Only ever populated for a survived claim; a dropped claim can never "touch" a
 * conflict (see the grounding gate's own doc comment on why forcing happens post-survival). */
type TouchedFactKeys = readonly FactKey[];

export type ClaimVerificationResult =
  | {
      readonly kind: 'survived';
      /** The claim with any citation locator upgraded per check 4. */
      readonly claim: Claim;
      readonly violations: readonly GroundingViolation[];
      readonly touchedFactKeys: TouchedFactKeys;
      /** Set only when `atoms` was supplied to `verifyClaim` — see `verifyAtoms`'s own doc comment. */
      readonly atomization?: { readonly coverageFallback: boolean; readonly atomDropped: boolean };
    }
  | {
      readonly kind: 'dropped';
      readonly dropped: DroppedClaim;
      readonly violations: readonly GroundingViolation[];
      readonly touchedFactKeys: TouchedFactKeys;
      /** Set only when `atoms` was supplied to `verifyClaim` — see `verifyAtoms`'s own doc comment. */
      readonly atomization?: { readonly coverageFallback: boolean; readonly atomDropped: boolean };
    };

/** What `verifyStatement` needs beyond the statement text itself: everything `verifyClaim` receives
 * except `claim` and `atoms` — the citations checks 1-3 read stay pinned to `claim` regardless of
 * which statement (the whole claim's, or one of its atoms) is under test. */
interface VerifyStatementContext {
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly cellFacts: readonly GroundingCellFact[];
  readonly subjectBinding: boolean;
  readonly measures?: readonly VerifierMeasure[];
  readonly entities?: readonly CanonicalEntityListing[];
}

/**
 * Verifies one piece of text — `claim.statement` itself, or one of its decomposed atoms — against
 * `claim.citations`, in the four-check order the grounding gate documents: retrieval containment,
 * then quote containment, then quote alignment, then numeric (and, with `measures`, period)
 * support. Citations never vary by `statement`; only the text being checked against them does, so
 * `verifyAtoms` can call this once for the whole claim and again per atom without re-deriving
 * evidence. Fails CLOSED at this granularity — a single failing citation drops the *whole* check
 * (a model that pads one fabricated citation onto an otherwise-grounded claim does not get partial
 * credit), and a single unsupported number drops it the same way.
 */
function verifyStatement(
  statement: string,
  claim: Claim,
  context: VerifyStatementContext,
): ClaimVerificationResult {
  const { retrievedChunks, cellFacts, subjectBinding, measures, entities } = context;
  const chunkById = new Map(retrievedChunks.map((chunk) => [chunk.chunkId, chunk] as const));
  const normalizedStatement = normalizeEntityName(statement);
  const subjectEntities = subjectBinding
    ? collectSubjectEntities(normalizedStatement, cellFacts)
    : new Set<string>();

  const citationViolations: GroundingViolation[] = [];
  const citedChunks: RetrievedChunk[] = [];

  for (const citation of claim.citations) {
    const retrieved = chunkById.get(citation.chunkId);

    if (!retrieved) {
      // Check 1: retrieval containment. A citation's `docVersionId`/`sha256` are no longer
      // supplied by the model — `SynthesisService.resolveCitation` (`../synthesis.service.ts`)
      // resolves them server-side from the retrieved chunk a citation's `chunkId` names, before
      // this function ever runs — so a citation can only diverge from what was retrieved by
      // naming a `chunkId` that was never retrieved in the first place. There is no longer a
      // separate field-by-field provenance comparison to make once the lookup below succeeds,
      // because a successful lookup is exactly where `citation.docVersionId`/`citation.sha256`
      // came from. With `subjectBinding` off (the default), this `chunkById.get` is the entire
      // containment check: it proves the cited chunk was among the chunks retrieved for this
      // request, nothing less and nothing more. On, it is joined below by a subject-entity check
      // over the same lookup's result.
      citationViolations.push({
        kind: 'chunk-not-retrieved',
        claimStatement: statement,
        detail: `chunk '${citation.chunkId}' was not among the chunks retrieved for this request`,
        chunkId: citation.chunkId,
      });
      continue;
    }

    const match = locateQuote(citation.quote, retrieved.text);
    if (match.kind === 'none') {
      citationViolations.push({
        kind: 'quote-not-found',
        claimStatement: statement,
        detail: `quote for chunk '${citation.chunkId}' does not appear in the cited chunk's text`,
        chunkId: citation.chunkId,
      });
      continue;
    }
    if (match.kind === 'fuzzy') {
      citationViolations.push({
        kind: 'quote-fuzzy-match',
        claimStatement: statement,
        detail: `quote for chunk '${citation.chunkId}' only matches the cited chunk approximately (similarity ${match.similarity.toFixed(2)}), not verbatim`,
        chunkId: citation.chunkId,
      });
      continue;
    }

    // `subjectBinding` narrowing of check 1: a chunk that never even names an entity the claim's
    // own statement talks about is not proof of the claim, whatever else it says — reuses
    // `quote-unrelated-to-statement` rather than a new violation kind, since this is the same
    // "cited evidence doesn't actually relate to the statement" failure check 3 already names.
    // Inert when `subjectEntities` is empty: a claim naming no fact-bearing entity at all must not
    // be rejected for lacking one.
    if (
      subjectBinding &&
      subjectEntities.size > 0 &&
      !chunkContainsSubjectEntity(retrieved.text, subjectEntities)
    ) {
      citationViolations.push({
        kind: 'quote-unrelated-to-statement',
        claimStatement: statement,
        detail: `chunk '${citation.chunkId}' does not name this claim's subject entity`,
        chunkId: citation.chunkId,
      });
      continue;
    }

    citedChunks.push(retrieved);
  }

  if (citationViolations.length > 0) {
    return {
      kind: 'dropped',
      dropped: {
        statement,
        reason: citationViolations.map((violation) => violation.detail).join('; '),
      },
      violations: citationViolations,
      touchedFactKeys: [],
    };
  }

  // Check 3: every citation is retrieval-contained and quote-verified, but neither of those checks
  // relates a quote to the *statement* it is cited for — a quote can match its chunk verbatim while
  // being either too thin to support anything (`"the"`) or a real sentence about something else
  // entirely. `checkQuoteAlignment` closes that gap over the whole claim at once, not per citation,
  // because the floor is about the claim's total evidence, not any single quote in isolation. Only a
  // cell fact on a chunk this claim actually cited counts as corroboration — a fact on some other
  // retrieved-but-uncited chunk says nothing about whether *this* claim's number is genuine.
  const corroboratedNumericTokens = new Set(
    cellFacts
      .filter(
        (fact) =>
          citedChunks.some((chunk) => chunk.chunkId === fact.chunkId) &&
          // `fact.value.amount` is stored data, not something this module derives — an upstream
          // extraction defect could still hand it a non-finite value. `extractNumericTokens`
          // guarantees every numeric token a statement or quote can ever contribute is finite
          // (see that module's own doc comment), so a non-finite amount could never legitimately
          // match one anyway; excluding it here keeps `corroboratedNumericTokens` restricted to
          // values `checkQuoteAlignment` can actually compare against. Fails toward excluding a
          // value from corroboration, never toward including one — the safer direction for a
          // signal that only ever strengthens a claim's numeric support.
          Number.isFinite(fact.value.amount),
      )
      .map((fact) => fact.value.amount),
  );
  const alignment = checkQuoteAlignment({
    statement,
    quotes: claim.citations.map((citation) => citation.quote),
    corroboratedNumericTokens,
  });
  if (alignment.kind !== 'aligned') {
    const alignmentViolation: GroundingViolation =
      alignment.kind === 'quote-not-substantive'
        ? {
            kind: 'quote-not-substantive',
            claimStatement: statement,
            detail: `quote for chunk '${claim.citations[alignment.quoteIndex].chunkId}' does not carry enough content to support any claim`,
          }
        : {
            kind: 'quote-unrelated-to-statement',
            claimStatement: statement,
            detail:
              'the cited quotes share too little content with the claim statement to support it',
          };
    return {
      kind: 'dropped',
      dropped: { statement, reason: alignmentViolation.detail },
      violations: [alignmentViolation],
      touchedFactKeys: [],
    };
  }

  // Check 4: every citation is retrieval-contained, quote-verified, and alignment-verified. Every
  // number in the statement must still be supported — one unsupported number drops the whole check,
  // the same fail-closed granularity as check 1/2's per-citation failures above. The same value
  // match that proves support is also what `touchedFactKeys` (below) is built from — a fact only
  // counts as "touched" by this check when the statement actually states its value, not merely when
  // it lives in a cited chunk (see `TouchedFactKeys`'s doc comment). With `measures === undefined`
  // this is the legacy digit-matching loop; with `measures` supplied it defers to
  // `parseClaimAssertions`/`verifyStructuredSupport`, which bind numbers to a confirmed measure's
  // tolerance and a cell fact's entity/period rather than to raw digit equality.
  const numericViolations: GroundingViolation[] = [];
  const locatorUpgradeByChunkId = new Map<string, EvidenceLocator>();
  const touchedFacts: GroundingCellFact[] = [];

  if (measures === undefined) {
    // `extractNumericTokens` never returns a value for a digit run it cannot represent — a
    // non-ASCII `\p{Nd}` script (Arabic-Indic, Devanagari, ...) NFKC does not fold to ASCII, or an
    // ASCII digit run whose magnitude `isRepresentableToken` rejects (an 18-digit identifier, an
    // overflowing run of zeros); see that module's own doc comment on `containsUnrepresentableNumber`.
    // Either way the loop below would otherwise treat a statement stating one as though it stated no
    // number there at all. `containsUnrepresentableNumber` is the explicit signal for both cases,
    // consulted only against `statement` — never the cited chunks' text, whose own unrepresentable
    // numbers contribute no support and no violation, the same as any other number a chunk simply
    // does not corroborate.
    if (containsUnrepresentableNumber(statement)) {
      numericViolations.push({
        kind: 'numeric-claim-unsupported',
        claimStatement: statement,
        detail:
          'claim states a number this system cannot represent as a verifiable value (an unsupported digit script or a magnitude outside its safe range)',
      });
    }

    for (const claimedNumber of extractNumericTokens(statement)) {
      // With `subjectBinding` on, bare value equality is not enough: `isFactBoundToClaim` also
      // requires the fact's entity, metric, and unit to relate to this statement — closing the gap
      // where two distinct facts on the same cited chunk carry the identical amount (a claim about
      // entity A must never acquire a cell-precise locator pointing at entity B's identically-valued
      // figure).
      const supportingFact = cellFacts.find(
        (fact) =>
          fact.value.amount === claimedNumber &&
          citedChunks.some((chunk) => chunk.chunkId === fact.chunkId) &&
          (!subjectBinding || isFactBoundToClaim(fact, normalizedStatement, subjectEntities)),
      );

      if (supportingFact) {
        // A cell-level fact is strictly stronger evidence than a whole-region quote match, so it
        // always wins the upgrade regardless of whether the chunk text also happens to contain the
        // number verbatim.
        locatorUpgradeByChunkId.set(supportingFact.chunkId, supportingFact.locator);
        touchedFacts.push(supportingFact);
        continue;
      }

      // A cited chunk that carries *any* cell-level fact is treated as authoritative for numbers:
      // once structured extraction has a ground truth for that chunk, an unmatched value is
      // rejected rather than accepted on a coincidental digit substring elsewhere in the chunk's
      // raw text (comps sheets routinely repeat digits across unrelated columns/rows). Raw-text
      // fallback is only available for a chunk with zero cell facts — a genuinely prose chunk with
      // no structured extraction to defer to.
      const supportedByChunkText = citedChunks.some((chunk) => {
        const chunkHasCellFacts = cellFacts.some((fact) => fact.chunkId === chunk.chunkId);
        // Strict `===`, the same predicate check 4's cell-fact match above uses, over the same
        // guaranteed-finite `extractNumericTokens` output on both sides (see that module's own doc
        // comment) — a plain equality comparison, with no sentinel value either side could collide on.
        const chunkStatesClaimedNumber = extractNumericTokens(chunk.text).some(
          (token) => token === claimedNumber,
        );
        if (chunkHasCellFacts || !chunkStatesClaimedNumber) {
          return false;
        }
        // `subjectBinding` narrowing of the raw-text fallback: a zero-cell-fact chunk that carries
        // the claimed number verbatim is still not evidence for *this* statement unless it also
        // names a subject entity — otherwise any digit run in a 700-token prose chunk would support
        // any claim sharing that number. Every chunk reaching this point already passed check 1's
        // identical per-citation gate above, so this branch is currently unreachable in practice; it
        // is kept as an explicit backstop scoped to check 4's own fallback, so a future change to
        // check 1's gating cannot silently widen this one. Inert when `subjectEntities` is empty,
        // the same scoping check 1 uses.
        return (
          !subjectBinding ||
          subjectEntities.size === 0 ||
          chunkContainsSubjectEntity(chunk.text, subjectEntities)
        );
      });
      if (!supportedByChunkText) {
        numericViolations.push({
          kind: 'numeric-claim-unsupported',
          claimStatement: statement,
          detail: `claim states the number ${claimedNumber}, which is not supported by any cited chunk or extracted fact`,
        });
      }
    }
  } else {
    const assertions = parseClaimAssertions({ statement, measures, entities: entities ?? [] });
    // Always derived, independent of `subjectBinding` (which only gates the legacy branch above):
    // `verifyStructuredSupport`'s R1 binding needs a subject-entity set of its own regardless of
    // whether the caller opted into `subjectBinding`.
    const structuredSubjectEntities = new Set<string>([
      ...collectSubjectEntities(normalizedStatement, cellFacts),
      ...assertions.entityMentions,
    ]);
    const { violations: structuredViolations, supportingFacts } = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks,
      cellFacts,
      measures,
      subjectEntities: structuredSubjectEntities,
      subjectBinding,
    });
    numericViolations.push(...structuredViolations);
    for (const fact of supportingFacts) {
      locatorUpgradeByChunkId.set(fact.chunkId, fact.locator);
      touchedFacts.push(fact);
    }
  }

  if (numericViolations.length > 0) {
    return {
      kind: 'dropped',
      dropped: {
        statement,
        reason: numericViolations.map((violation) => violation.detail).join('; '),
      },
      violations: numericViolations,
      touchedFactKeys: [],
    };
  }

  const upgradedCitations: Citation[] = claim.citations.map((citation) => {
    const upgradedLocator = locatorUpgradeByChunkId.get(citation.chunkId);
    return upgradedLocator ? { ...citation, locator: upgradedLocator } : citation;
  });

  const touchedFactKeys = touchedFacts.map((fact) => fact.factKey);

  return {
    kind: 'survived',
    claim: { ...claim, citations: upgradedCitations },
    violations: [],
    touchedFactKeys,
  };
}

/**
 * Verifies a claim's citations against what was actually retrieved. With `atoms` omitted, this is
 * exactly `verifyStatement(claim.statement, claim, context)` — checks 1-3 unchanged, check 4 the
 * legacy digit-matching loop unless `measures` is also supplied, in which case check 4 defers to
 * `parseClaimAssertions`/`verifyStructuredSupport` (see `verifyStatement`'s own doc comment for both
 * paths). With `atoms` supplied, verification instead runs through `verifyAtoms`: the whole
 * statement is verified first via the same `verifyStatement`, and only a claim that survives on its
 * own is then checked atom by atom, monotonically — decomposition can never turn a claim the
 * whole-statement check already dropped into a survivor, and can only ever narrow what survives
 * further (`verify-atoms.ts`'s own doc comment covers the two invariants this establishes).
 */
export function verifyClaim(params: {
  readonly claim: Claim;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly cellFacts: readonly GroundingCellFact[];
  /**
   * Off by default (`undefined`/`false`) — every existing caller omits it, so behavior is
   * byte-identical until a caller opts in. When on, binds check 1's retrieval containment and check
   * 4's numeric support to the claim's subject entity (and, for check 4, `factKey.metric`/
   * `value.unit`) rather than accepting a cited chunk, or a value-matched fact, on name or number
   * alone. See `collectSubjectEntities`'s doc comment for what "subject entity" means given `Claim`
   * has no structured field to read it from.
   */
  readonly subjectBinding?: boolean;
  /** The claim's model-decomposed atoms (`ClaimDecompositionService`). Omitted means "not
   * decomposed" — the whole statement is the only thing verified, byte-identical to today. */
  readonly atoms?: readonly string[];
  /** Confirmed measures (`MeasuresService.listConfirmedDefinitions`, projected to
   * `VerifierMeasure`). Omitted means check 4 stays the legacy digit-matching loop. */
  readonly measures?: readonly VerifierMeasure[];
  /** Canonical entities, used by `parseClaimAssertions` to recognize a mentioned entity by alias as
   * well as by canonical name. Only read when `measures` is also supplied. */
  readonly entities?: readonly CanonicalEntityListing[];
}): ClaimVerificationResult {
  const {
    claim,
    retrievedChunks,
    cellFacts,
    subjectBinding = false,
    atoms,
    measures,
    entities,
  } = params;
  const context: VerifyStatementContext = {
    retrievedChunks,
    cellFacts,
    subjectBinding,
    measures,
    entities,
  };

  if (atoms === undefined) {
    return verifyStatement(claim.statement, claim, context);
  }

  return verifyAtoms({
    claim,
    atoms,
    verifyStatement: (statement) => verifyStatement(statement, claim, context),
  });
}
