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

  /**
   * `true` only for an `xlsx-cell` element the merge-propagation pass re-emitted onto a cell
   * covered by a merge — never on the merge's own master cell, and never on any other format's
   * elements. Citation resolution and header/entity/period lookups still need this element; only a
   * fact-minting loop that walks every cell in a row needs to skip it, or a merge spanning several
   * metric columns mints one identical fact per column instead of one (`xlsx-fact-extractor.ts`).
   */
  readonly mergeCovered?: true;
}

export interface ParsedDocument {
  readonly elements: readonly ParsedElement[];
  /**
   * Stamped onto every locator. Bump it whenever a change to a parser could shift the
   * coordinates it emits — a citation created under one extractor is not verifiable under
   * another, and this is what lets that be detected instead of silently mis-resolving.
   */
  readonly extractorVersion: string;

  /**
   * Reasons this parse is known to have lost fidelity (e.g. a layout the parser cannot
   * reconstruct correctly). Absent or empty when a parser has no such signal to report —
   * `IngestionService` treats both the same as "no reduced-fidelity reasons".
   */
  readonly reducedFidelityReasons?: readonly string[];
}

export interface DocumentParser {
  /** MIME types this parser claims. Used to dispatch, so it must be exact, not a prefix match. */
  readonly supports: readonly string[];
  parse(content: Buffer): Promise<ParsedDocument>;
}
