import type { ClaimVerdict } from '../../../../src/features/evidence/qa/contracts/verify-claims.contract';
import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  ClaimOutcome,
  CorpusChunk,
  CorpusDocument,
  DraftedClaim,
} from '../../../../scripts/experiments/verifier/types';

/** Fabricated inputs for the verifier experiment's pure modules — no database, no model, no
 *  Nest container. Mirrors `test/utils`' factory convention. */

export function makeLocator(page = 3): EvidenceLocator {
  return { kind: 'pdf-page', page, extractorVersion: 'pdfjs-1' };
}

export function makeChunk(overrides: Partial<CorpusChunk> = {}): CorpusChunk {
  return {
    chunkId: 'chunk-1',
    text: 'Net operating income for 2024 was 1,200,000.',
    tokenCount: 12,
    locator: makeLocator(),
    ...overrides,
  };
}

export function makeDocument(overrides: Partial<CorpusDocument> = {}): CorpusDocument {
  return {
    filename: 'om.pdf',
    documentVersionId: 'version-1',
    chunks: [makeChunk()],
    ...overrides,
  };
}

export function makeDraftedClaim(overrides: Partial<DraftedClaim> = {}): DraftedClaim {
  return {
    claimId: 'c001',
    statement: 'Net operating income for 2024 was 1,200,000.',
    sourceFilename: 'om.pdf',
    draftPass: 0,
    ...overrides,
  };
}

export function makeOutcome(overrides: Partial<ClaimOutcome> = {}): ClaimOutcome {
  return {
    ...makeDraftedClaim(),
    verdict: 'grounded',
    ...overrides,
  };
}

/** `count` outcomes with sequential ids, every one carrying `verdict`. */
export function makeOutcomes(count: number, verdict: ClaimVerdict, startAt = 1): ClaimOutcome[] {
  return Array.from({ length: count }, (_, index) =>
    makeOutcome({
      claimId: `c${String(startAt + index).padStart(3, '0')}`,
      statement: `claim number ${startAt + index}`,
      verdict,
    }),
  );
}
