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

/** Fact keys of every `cellFacts` entry sharing a chunk with one of this claim's citations — only
 * ever populated for a survived claim; a dropped claim can never "touch" a conflict (see the
 * grounding gate's own doc comment on why forcing happens post-survival). */
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
      // Check 1a: a model citing a chunk it was never shown has fabricated it, regardless of
      // whether that chunk exists in the database at all.
      citationViolations.push({
        kind: 'chunk-not-retrieved',
        claimStatement: claim.statement,
        detail: `chunk '${citation.chunkId}' was not among the chunks retrieved for this request`,
        chunkId: citation.chunkId,
      });
      continue;
    }

    if (retrieved.docVersionId !== citation.docVersionId || retrieved.sha256 !== citation.sha256) {
      // Check 1b: the chunk id alone is not the whole citation — a real chunk id paired with a
      // fabricated document version or hash is still an unverifiable claim about provenance.
      citationViolations.push({
        kind: 'citation-provenance-mismatch',
        claimStatement: claim.statement,
        detail: `citation for chunk '${citation.chunkId}' does not match the retrieved chunk's document version or hash`,
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
  // fail-closed granularity as check 1/2's per-citation failures above.
  const numericViolations: GroundingViolation[] = [];
  const locatorUpgradeByChunkId = new Map<string, EvidenceLocator>();

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
      continue;
    }

    const supportedByChunkText = citedChunks.some((chunk) =>
      extractNumericTokens(chunk.text).includes(claimedNumber),
    );
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

  const touchedFactKeys = cellFacts
    .filter((fact) => citedChunks.some((chunk) => chunk.chunkId === fact.chunkId))
    .map((fact) => fact.factKey);

  return {
    kind: 'survived',
    claim: { ...claim, citations: upgradedCitations },
    violations: [],
    touchedFactKeys,
  };
}
