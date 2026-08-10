import { renderPdfFromPages, type PdfBuildResult, type PdfPageSpec } from './pdf-helpers';

const TITLE = 'Valuation Memorandum — Meridian Corridor Comparable Set';

/**
 * valuation-memo.pdf. Page 2 deliberately restates Northgate Business Park's cap rate as
 * 6.10% — the stale half of the seeded cross-format conflict against comps.xlsx!F2 (5.25%,
 * current). See lib/constants.ts SEEDED_CONFLICT for the canonical record of both values.
 *
 * Exported as page-spec data (not only PDFDocument calls) so the synthetic-content sweep can
 * grep this module's literal strings directly rather than parsing a compressed PDF stream.
 */
export const VALUATION_MEMO_PAGES: PdfPageSpec[] = [
  {
    heading: 'Executive Summary',
    paragraphs: [
      'This memorandum reviews ten comparable transactions surveyed across the Meridian ' +
        'Corridor and adjacent submarkets between September 2024 and August 2025. The comparable ' +
        'set spans office, industrial, retail, and mixed-use product, and forms the basis for the ' +
        'cap rate and pricing conclusions in this memo.',
      'Underlying transaction data, including sale price, building area, and net operating ' +
        'income for each comparable, is maintained in the accompanying comps.xlsx workbook and is ' +
        'not restated in full here.',
    ],
  },
  {
    heading: 'Comparable Transactions Overview',
    paragraphs: [
      'Northgate Business Park traded in March 2025 for $41,000,000 ($276.10 per square foot) ' +
        'at a cap rate of approximately 6.10%, consistent with prevailing suburban office cap ' +
        'rates at the time the asset was first underwritten.',
      'Cedar Bluff Logistics Center, the largest asset in the comparable set at 412,000 square ' +
        'feet, closed in May 2025, reflecting continued investor appetite for last-mile industrial ' +
        'product within the corridor.',
      'Sablewood Retail Court and Cobalt Harbor Mixed-Use round out the retail and mixed-use ' +
        'segments of the comparable set, trading at cap rates of 6.05% and 4.55% respectively.',
    ],
  },
  {
    heading: 'Valuation Conclusion',
    paragraphs: [
      'Based on the comparable set, we recommend a stabilized going-in cap rate range of ' +
        '5.10%–5.40% for institutional-quality industrial and flex assets within the Meridian ' +
        'Corridor, with office and retail product priced at a premium of 40–80 basis points over ' +
        'that range depending on tenancy profile.',
    ],
  },
  {
    heading: 'Portfolio Risk Notes',
    paragraphs: [
      'Sablewood Retail Court carries elevated cap rate execution risk: the lease governing its ' +
        "anchor tenant includes a co-tenancy clause triggered by the anchor's below-average sales " +
        'performance in fiscal year 2025, which could accelerate a lease termination right.',
    ],
  },
];

export async function buildValuationMemo(): Promise<PdfBuildResult> {
  return renderPdfFromPages(TITLE, VALUATION_MEMO_PAGES);
}
