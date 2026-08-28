import { renderPdfFromPages, type PdfBuildResult, type PdfPageSpec } from '../../lib/pdf-helpers';

const TITLE = 'Fixture Estate — Insurance Certificate';

const PAGES: PdfPageSpec[] = [
  {
    heading: 'Certificate of Insurance',
    paragraphs: [
      'This certificate confirms property and general liability coverage for the fixture estate, ' +
        'effective for the current policy period.',
      'Coverage limits, carrier details, and endorsements are recorded in the underlying policy ' +
        'documents held by the estate manager, not restated in full here.',
    ],
  },
];

/** The well-formed PDF `build-truncated-pdf.ts` cuts down — kept as its own module so the "before"
 *  content is inspectable independently of the truncation it undergoes. */
export async function buildTruncatedPdfSource(): Promise<PdfBuildResult & { description: string }> {
  const built = await renderPdfFromPages(TITLE, PAGES);
  return { ...built, description: TITLE };
}
