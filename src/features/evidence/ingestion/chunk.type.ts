import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/**
 * The chunker's output shape — one retrievable, embeddable unit. Mirrors `ParsedElement`
 * (`parsers/parsed-element.type.ts`) as the next contract in the pipeline: parsers produce the
 * finest addressable spans, the chunker regroups them into units sized for embedding and
 * retrieval.
 */
export interface Chunk {
  readonly text: string;
  readonly tokenCount: number;
  readonly locator: EvidenceLocator;
}
