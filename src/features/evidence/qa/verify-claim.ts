import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  FactKey,
  FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { Citation, Claim, DroppedClaim } from './contracts/answer.contract';
import { extractNumericTokens } from './extract-numeric-tokens';
import { locateQuote } from './locate-quote';
import type { RetrievedChunk } from './types/retrieved-chunk.type';
import type { GroundingViolation } from './types/grounding-report.type';

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
 * facts check 3 finds while verifying numeric support, not every fact sharing a cited chunk.
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
      /** The claim with any citation locator upgraded per check 3. */
      readonly claim: Claim;
      readonly violations: readonly GroundingViolation[];
      readonly touchedFactKeys: TouchedFactKeys;
    }
  | {
      readonly kind: 'dropped';
      readonly dropped: DroppedClaim;
      readonly violations: readonly GroundingViolation[];
      readonly touchedFactKeys: TouchedFactKeys;
    };

/**
 * Verifies one claim's citations against what was actually retrieved, in the three-check order the
 * grounding gate documents: retrieval containment, then quote containment, then numeric support.
 * Fails CLOSED at claim granularity — a single failing citation drops the *whole* claim (a model
 * that pads one fabricated citation onto an otherwise-grounded claim does not get partial credit),
 * and a single unsupported number in an otherwise-grounded claim drops it the same way.
 */
export function verifyClaim(params: {
  readonly claim: Claim;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly cellFacts: readonly GroundingCellFact[];
}): ClaimVerificationResult {
  const { claim, retrievedChunks, cellFacts } = params;
  const chunkById = new Map(retrievedChunks.map((chunk) => [chunk.chunkId, chunk] as const));

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
      // came from. This `chunkById.get` is now the entire containment check: it proves the cited
      // chunk was among the chunks retrieved for this request, nothing less and nothing more.
      citationViolations.push({
        kind: 'chunk-not-retrieved',
        claimStatement: claim.statement,
        detail: `chunk '${citation.chunkId}' was not among the chunks retrieved for this request`,
        chunkId: citation.chunkId,
      });
      continue;
    }

    const match = locateQuote(citation.quote, retrieved.text);
    if (match.kind === 'none') {
      citationViolations.push({
        kind: 'quote-not-found',
        claimStatement: claim.statement,
        detail: `quote for chunk '${citation.chunkId}' does not appear in the cited chunk's text`,
        chunkId: citation.chunkId,
      });
      continue;
    }
    if (match.kind === 'fuzzy') {
      citationViolations.push({
        kind: 'quote-fuzzy-match',
        claimStatement: claim.statement,
        detail: `quote for chunk '${citation.chunkId}' only matches the cited chunk approximately (similarity ${match.similarity.toFixed(2)}), not verbatim`,
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
        statement: claim.statement,
        reason: citationViolations.map((violation) => violation.detail).join('; '),
      },
      violations: citationViolations,
      touchedFactKeys: [],
    };
  }

  // Check 3: every citation is retrieval-contained and quote-verified. Every number in the
  // statement must still be supported — one unsupported number drops the whole claim, the same
  // fail-closed granularity as check 1/2's per-citation failures above. The same value match that
  // proves support is also what `touchedFactKeys` (below) is built from — a fact only counts as
  // "touched" by this claim when the claim actually states its value, not merely when it lives in
  // a cited chunk (see `TouchedFactKeys`'s doc comment).
  const numericViolations: GroundingViolation[] = [];
  const locatorUpgradeByChunkId = new Map<string, EvidenceLocator>();
  const touchedFacts: GroundingCellFact[] = [];

  for (const claimedNumber of extractNumericTokens(claim.statement)) {
    const supportingFact = cellFacts.find(
      (fact) =>
        fact.value.amount === claimedNumber &&
        citedChunks.some((chunk) => chunk.chunkId === fact.chunkId),
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
      return !chunkHasCellFacts && extractNumericTokens(chunk.text).includes(claimedNumber);
    });
    if (!supportedByChunkText) {
      numericViolations.push({
        kind: 'numeric-claim-unsupported',
        claimStatement: claim.statement,
        detail: `claim states the number ${claimedNumber}, which is not supported by any cited chunk or extracted fact`,
      });
    }
  }

  if (numericViolations.length > 0) {
    return {
      kind: 'dropped',
      dropped: {
        statement: claim.statement,
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
