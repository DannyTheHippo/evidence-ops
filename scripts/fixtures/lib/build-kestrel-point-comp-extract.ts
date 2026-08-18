import { AREA_CONFLICT_PROPERTY, SEEDED_AREA_CONFLICT } from './constants';
import { renderPdfFromPages, type PdfBuildResult, type PdfPageSpec } from './pdf-helpers';

const TITLE = 'Comparable Set Extract — Kestrel Point Submarket';

/**
 * kestrel-point-comp-extract.pdf. A printed export of an underwriting comparable-set spreadsheet
 * — `sourceClass: 'spreadsheet'` in `eval/ingest-fixtures.ts` even though its `sourceKind` is
 * `pdf`, the two fields being independent (`document.schema.ts`). Carries the middle-ranked of
 * `SEEDED_AREA_CONFLICT`'s three building-area figures.
 *
 * Exported as page-spec data so the synthetic-content sweep can grep this module's literal
 * strings directly, matching `build-valuation-memo.ts`'s `VALUATION_MEMO_PAGES` convention.
 */
export const COMP_EXTRACT_PAGES: PdfPageSpec[] = [
  {
    heading: 'Comparable Set Extract',
    paragraphs: [
      'This extract reproduces one row of the underwriting comparable-set spreadsheet for ' +
        'distribution outside the modeling workbook.',
      `${AREA_CONFLICT_PROPERTY} is carried in the comparable set at a building area of ` +
        `${SEEDED_AREA_CONFLICT.spreadsheetValue.display} square feet.`,
    ],
  },
];

export async function buildKestrelPointCompExtract(): Promise<PdfBuildResult> {
  return renderPdfFromPages(TITLE, COMP_EXTRACT_PAGES);
}
