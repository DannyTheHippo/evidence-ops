import { renderPdf, renderHeading, type PdfBuildResult } from '../../lib/pdf-helpers';

const LEFT_COLUMN =
  'Left column: operating expenses for the fixture estate increased 4.1% year over year, driven ' +
  'primarily by utilities and contracted landscaping costs across the property.';
const RIGHT_COLUMN =
  'Right column: base rent collections remained stable at 98.6% of billed amounts, with the sole ' +
  'delinquency attributable to a single ground-floor retail suite under active collection.';

const COLUMN_WIDTH = 220;
const LEFT_X = 72;
const RIGHT_X = 72 + COLUMN_WIDTH + 32;
const COLUMN_TOP_Y = 140;

/**
 * `two-column.pdf`: one page laid out as two side-by-side text blocks via explicit `x`/`width`
 * rather than pdfkit's linear content flow. pdfkit extracts text in the order it was written, so
 * this page's reading order is left-column-then-right-column, not the top-to-bottom-across-both-
 * columns order a human reader would use — the layout gap `pdf.parser.ts`'s heading/element
 * extraction does not attempt to resolve, which is exactly what this fixture is for.
 */
export async function buildTwoColumnPdf(): Promise<PdfBuildResult> {
  return renderPdf(
    'Fixture Estate — Quarterly Operating Notes',
    (doc, addFooter) => {
      doc.addPage();
      renderHeading(doc, 'Quarterly Operating Notes');
      doc
        .fontSize(11)
        .font('Helvetica')
        .text(LEFT_COLUMN, LEFT_X, COLUMN_TOP_Y, { width: COLUMN_WIDTH, align: 'left' });
      doc
        .fontSize(11)
        .font('Helvetica')
        .text(RIGHT_COLUMN, RIGHT_X, COLUMN_TOP_Y, { width: COLUMN_WIDTH, align: 'left' });
      addFooter();
    },
    1,
  );
}
