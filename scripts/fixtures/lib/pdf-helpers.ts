import PDFDocument from 'pdfkit';

import { DOCUMENT_AUTHOR, FIXED_DOCUMENT_DATE } from './constants';

export interface PdfBuildResult {
  buffer: Buffer;
  pageCount: number;
}

/**
 * pdfkit derives the PDF's /ID trailer entry from a hash of `info` (see pdfkit source,
 * PDFSecurity.generateFileID: `md5(info.CreationDate.getTime() + ...)`) rather than from
 * random bytes or wall-clock time elsewhere, so pinning CreationDate here is what makes the
 * whole file byte-identical across runs — no zip-style repack step is needed for PDF output.
 * Standard-14 fonts only (no embedded font files) removes another source of run-to-run drift
 * from subsetting order.
 */
export async function renderPdf(
  title: string,
  build: (doc: PDFKit.PDFDocument, addFooter: () => void) => void,
  expectedPageCount: number,
): Promise<PdfBuildResult> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      // pdfkit creates the first page inside the constructor, before any listener can attach —
      // so a `pageAdded` counter would silently miss it. Making every page explicit keeps the
      // count exact rather than correct-by-off-by-one-adjustment.
      autoFirstPage: false,
      info: {
        Title: title,
        Author: DOCUMENT_AUTHOR,
        Subject: 'Synthetic evidence-ops fixture',
        CreationDate: FIXED_DOCUMENT_DATE,
        ModDate: FIXED_DOCUMENT_DATE,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    let pageNumber = 0;
    // Counts PHYSICAL pages, including any pdfkit adds on its own. Counting addFooter() calls
    // instead measured intent rather than output: it reported 4 while the file really had 8,
    // because every footer was landing on an auto-inserted page (see addFooter below). A page
    // guard that cannot see an unwanted page is not a guard.
    let renderedPages = 0;
    doc.on('pageAdded', () => {
      renderedPages += 1;
    });

    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (renderedPages !== expectedPageCount) {
        reject(
          new Error(
            `${title}: expected ${expectedPageCount} pages, rendered ${renderedPages}. ` +
              'Page-number locators in the manifest and eval dataset index physical pages, so a ' +
              'stray blank page silently shifts every citation after it.',
          ),
        );
        return;
      }
      resolve({ buffer, pageCount: renderedPages });
    });
    doc.on('error', reject);

    const addFooter = (): void => {
      pageNumber += 1;
      const currentPage = pageNumber;
      // The footer sits at height-50, i.e. inside the 72pt bottom margin. pdfkit treats writing
      // below the margin as content overflow and helpfully starts a new page — which is how the
      // footer ended up alone on a page of its own. Dropping the bottom margin for the duration
      // of this one write keeps it on the page it belongs to.
      const originalBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .fontSize(8)
        .fillColor('#666666')
        .text(`Page ${currentPage} of ${expectedPageCount}`, 72, doc.page.height - 50, {
          width: doc.page.width - 144,
          align: 'center',
          lineBreak: false,
        })
        .fillColor('#000000');
      doc.page.margins.bottom = originalBottomMargin;
    };

    build(doc, addFooter);
    doc.end();
  });
}

export function renderHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(16).font('Helvetica-Bold').text(text, { align: 'left' }).moveDown(0.75);
  doc.font('Helvetica').fontSize(11);
}

export function renderParagraph(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(11).font('Helvetica').text(text, { align: 'left' }).moveDown(1);
}

export interface PdfPageSpec {
  heading: string;
  paragraphs: string[];
}

/**
 * One page per PdfPageSpec, in order. Keeping page content as data (rather than only as calls
 * inside a callback) lets the synthetic-content sweep (test/fixtures/synthetic-content.spec.ts)
 * grep the exact strings a page renders instead of reverse-engineering them from a compressed
 * PDF content stream.
 */
export async function renderPdfFromPages(
  title: string,
  pages: PdfPageSpec[],
): Promise<PdfBuildResult> {
  return renderPdf(
    title,
    (doc, addFooter) => {
      // One explicit addPage() per spec, including the first (autoFirstPage is off).
      for (const page of pages) {
        doc.addPage();
        renderHeading(doc, page.heading);
        for (const paragraph of page.paragraphs) {
          renderParagraph(doc, paragraph);
        }
        addFooter();
      }
    },
    pages.length,
  );
}
