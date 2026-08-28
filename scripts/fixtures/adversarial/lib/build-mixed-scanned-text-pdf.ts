import {
  renderPdf,
  renderHeading,
  renderParagraph,
  type PdfBuildResult,
} from '../../lib/pdf-helpers';

/**
 * `mixed-scanned-text.pdf`: page 1 carries real, extractable text; page 2 carries only vector
 * graphics — no `doc.text()` call at all — standing in for a scanned page with no text layer
 * (pdfkit has no image-embedding fixture data to draw on here, but the property under test is
 * identical either way: a page pdfkit's own text extraction returns nothing for). `pdf.parser.ts`
 * emits one element per page with extractable text and nothing for a page with none; this fixture
 * is for observing that page 2 contributes no element rather than a malformed one.
 */
export async function buildMixedScannedTextPdf(): Promise<PdfBuildResult> {
  return renderPdf(
    'Fixture Estate — Site Photo Log',
    (doc, addFooter) => {
      doc.addPage();
      renderHeading(doc, 'Site Photo Log — Cover Sheet');
      renderParagraph(
        doc,
        'This log accompanies the site inspection conducted for the fixture estate. The following ' +
          'page reproduces one inspection photo; it carries no text layer.',
      );
      addFooter();

      doc.addPage();
      // No text call on this page at all — only a filled rectangle standing in for a photo, so
      // `pdf.parser.ts` sees a page with zero extractable text, the same shape a scanned image
      // page produces.
      doc.rect(72, 120, doc.page.width - 144, 400).fillAndStroke('#d9d9d9', '#999999');
      addFooter();
    },
    2,
  );
}
