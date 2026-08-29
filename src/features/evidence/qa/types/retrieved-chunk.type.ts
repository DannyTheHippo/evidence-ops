import type { DocumentSourceClass } from '../../../../database/schemas/evidence/document/document.schema';
import type { EvidenceLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/**
 * What the grounding gate is allowed to treat as "shown to the model for this request" — the same
 * fields a `Citation` (`../contracts/answer.contract.ts`) pins, so retrieval containment can be
 * checked field-by-field (chunk id, doc version, hash) rather than trusting `chunkId` alone. The
 * retrieval layer (`src/providers/retrieval/**`, owned elsewhere) returns a generic
 * `RetrievalHit<TMetadata>`; the caller that resolves hits into evidence chunks is responsible for
 * projecting them into this shape before calling `GroundingGateService.verify`.
 */
export interface RetrievedChunk {
  readonly chunkId: string;
  readonly docVersionId: string;
  readonly sha256: string;
  readonly text: string;
  readonly locator: EvidenceLocator;
  // Optional here, not on `RetrievedChunkResponseDto`: grounding never reads these, so a fixture
  // built for `GroundingGateService`/`SynthesisService` coverage is not obligated to carry them.
  // `EvidenceRetrievalService.retrieve` always populates all five.
  readonly score?: number;
  readonly documentId?: string;
  readonly documentTitle?: string;
  readonly sourceClass?: DocumentSourceClass;
  readonly documentCreatedAt?: Date;
}
