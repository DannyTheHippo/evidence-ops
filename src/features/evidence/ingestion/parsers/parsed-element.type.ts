import type { EvidenceLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/**
 * The one shape every parser produces, so chunking never learns which format it came from.
 *
 * An element is the smallest span the extractor can address: a PDF page, a DOCX paragraph, an
 * XLSX cell. Chunking later groups elements into retrievable units; keeping the parser output
 * fine-grained means a chunk's locator can always be narrowed to the elements it actually spans,
 * and never the other way round.
 */
export interface ParsedElement {
  /**
   * Sanitized at parse time — see `sanitizeEvidenceText`. Anything downstream, including the
   * prompt builder and the grounding gate's quote-containment check, compares against this exact
   * string, so escaping must happen once, here, rather than at each consumer.
   */
  readonly text: string;

  readonly locator: EvidenceLocator;

  /**
   * Section trail for structure-aware chunking (e.g. `['Market Overview', 'Supply']`). Empty when
   * the format carries no heading structure. `DocxParagraphLocator` also stores this because a
   * citation must be resolvable without re-parsing; this copy is for the chunker's convenience.
   */
  readonly headingPath: readonly string[];
}

export interface ParsedDocument {
  readonly elements: readonly ParsedElement[];
  /**
   * Stamped onto every locator. Bump it whenever a change to a parser could shift the
   * coordinates it emits — a citation created under one extractor is not verifiable under
   * another, and this is what lets that be detected instead of silently mis-resolving.
   */
  readonly extractorVersion: string;
}

export interface DocumentParser {
  /** MIME types this parser claims. Used to dispatch, so it must be exact, not a prefix match. */
  readonly supports: readonly string[];
  parse(content: Buffer): Promise<ParsedDocument>;
}
