import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/**
 * One constituent element a chunk spans, retained alongside its own text so a citation's quote can
 * be resolved back to the specific element it came from (`resolveCitationLocator`, `chunker.ts`)
 * rather than only the chunk's anchor `locator`, which names just the first spanned element. A
 * prose chunk's first entry can be borrowed from the *previous* chunk's closing text (the overlap
 * prefix `chunkProseRun` splices onto `text`) rather than one of this chunk's own elements — its
 * `locator` still names where that text actually lives.
 */
export interface ChunkElement {
  readonly locator: EvidenceLocator;
  readonly text: string;
}

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
  /**
   * The elements this chunk was built from, each with its own text. A prose chunk always carries
   * at least the one element `locator` anchors to, plus a leading overlap element where one
   * applies (see `ChunkElement`'s doc comment). A spreadsheet row-window chunk carries a header
   * element and a data element (`chunkSheet`), each with its own tighter range than the chunk's
   * own `locator`; a spreadsheet preamble chunk carries none, since its own `locator` is already
   * an exact range and needs no finer resolution.
   */
  readonly elements: readonly ChunkElement[];
}
