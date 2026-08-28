import type { EvidenceLocator } from '../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';

/**
 * The three markers the worksheet writer emits and the worksheet parser reads back. Shared so the
 * hand-filled file can never be written in one shape and parsed in another.
 */
export const CLAIM_HEADING_PATTERN = /^###\s+claim\s+(\S+)\s*$/;
export const ADJUDICATION_LINE_PATTERN = /^-\s*\*\*Adjudication:\*\*\s*(.*)$/;
export const NOTE_LINE_PATTERN = /^-\s*\*\*Note:\*\*\s*(.*)$/;

/** How many retrieval hits `ClaimVerificationService` shows the verifying model per claim. The
 *  worksheet marks that boundary so a reader can tell what the gate saw from what it did not. */
export const VERIFIER_SHORTLIST_SIZE = 5;

/** Fence delimiter for quoted source text. Tilde-fenced so a backtick fence inside a source
 *  document cannot terminate the block early. */
export const SOURCE_FENCE = '~~~';

/** Human-readable coordinates for one locator, short enough to sit on a list line. */
export function formatLocator(locator: EvidenceLocator): string {
  switch (locator.kind) {
    case 'pdf-page':
      return `page ${locator.page}`;
    case 'docx-paragraph':
      return `paragraph ${locator.paragraphIndex}`;
    case 'xlsx-region':
      return `${locator.sheetName}!${locator.range}`;
    case 'xlsx-cell':
      return `${locator.sheetName}!${locator.cell}`;
    case 'text-block':
      return `block ${locator.blockIndex}`;
    case 'pptx-slide':
      return `slide ${locator.slide}`;
  }
}
