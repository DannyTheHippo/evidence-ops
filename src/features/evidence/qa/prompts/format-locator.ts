import type { EvidenceLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

/**
 * Renders a locator as the short, human-readable string a citation label carries in the prompt
 * (e.g. "PDF page 3", "XLSX sheet 'Rent Roll' cell B7"). This is display text for the model, not
 * a serialization of the locator — the model never needs to reconstruct the structured locator
 * itself, only to read where a quote came from and reproduce the `chunkId` in a citation.
 */
export function formatLocator(locator: EvidenceLocator): string {
  switch (locator.kind) {
    case 'pdf-page':
      return `PDF page ${locator.page}`;
    case 'docx-paragraph':
      return locator.headingPath.length > 0
        ? `DOCX paragraph ${locator.paragraphIndex} (${locator.headingPath.join(' > ')})`
        : `DOCX paragraph ${locator.paragraphIndex}`;
    case 'xlsx-region':
      return `XLSX sheet '${locator.sheetName}' range ${locator.range}`;
    case 'xlsx-cell':
      return `XLSX sheet '${locator.sheetName}' cell ${locator.cell}`;
    case 'text-block':
      return `Text block ${locator.blockIndex} (${locator.headingPath.join(' > ')})`;
    case 'pptx-slide':
      return `PPTX slide ${locator.slide}`;
  }
}
