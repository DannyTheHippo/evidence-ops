import { renderPdfFromPages, type PdfBuildResult, type PdfPageSpec } from '../../lib/pdf-helpers';

const TITLE = 'Rent Roll Summary — Fixture Estate';

/**
 * Same content, deliberately placed under two different folders by `generate-adversarial-tree.ts`
 * (`duplicates/folder-a/rent-roll-summary.pdf` and `duplicates/folder-b/rent-roll-summary.pdf`) —
 * two distinct `relativePath`s that hash to the same sha256. `SourcesService.syncOneFile` keys its
 * watermark and dedupe check on `relativePath`, not on content, so both paths sync as independent,
 * brand-new files; whether the two collapse into one `Document` or two is decided by
 * `compute-chunk-id.ts`'s content-addressed chunk ids downstream, not by this fixture.
 */
export const DUPLICATE_PAIR_PAGES: PdfPageSpec[] = [
  {
    heading: 'Rent Roll Summary',
    paragraphs: [
      'This summary lists the current rent roll for the fixture estate as of the reporting date, ' +
        'covering twelve leased suites across a single building.',
      'Every figure in this summary is synthetic and generated for fixture purposes only — no real ' +
        'tenant, address, or financial figure is represented here.',
    ],
  },
];

export async function buildDuplicatePairContent(): Promise<PdfBuildResult> {
  return renderPdfFromPages(TITLE, DUPLICATE_PAIR_PAGES);
}
