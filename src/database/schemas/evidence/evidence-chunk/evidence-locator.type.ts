/**
 * Discriminated union of where an EvidenceChunk's text physically came from in its source
 * document. `extractorVersion` lives on every variant, not just on the chunk, because a
 * citation (see `answer.contract.ts`) only carries the locator itself — a citation that cannot
 * say which extractor produced its coordinates is not verifiable once a parser upgrade shifts
 * page/paragraph/cell offsets.
 *
 * Mirrored (structurally, not by import) as `locatorSchema` in
 * `src/features/evidence/qa/contracts/answer.contract.ts`, which needs a zod version to validate
 * the model's structured output and to derive its JSON Schema constraint. Database schemas do
 * not depend on feature contracts, so the two are kept in sync by convention; a compile-time
 * assignability check in `answer.contract.spec.ts` fails `tsc` if they drift apart.
 */
interface LocatorBase {
  extractorVersion: string;
}

export interface PdfPageLocator extends LocatorBase {
  kind: 'pdf-page';
  page: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface DocxParagraphLocator extends LocatorBase {
  kind: 'docx-paragraph';
  paragraphIndex: number;
  headingPath: string[];
}

export interface XlsxRegionLocator extends LocatorBase {
  kind: 'xlsx-region';
  sheetName: string;
  range: string;
}

export interface XlsxCellLocator extends LocatorBase {
  kind: 'xlsx-cell';
  sheetName: string;
  cell: string;
}

export type EvidenceLocator =
  PdfPageLocator | DocxParagraphLocator | XlsxRegionLocator | XlsxCellLocator;

export const EVIDENCE_LOCATOR_KINDS = [
  'pdf-page',
  'docx-paragraph',
  'xlsx-region',
  'xlsx-cell',
] as const;
