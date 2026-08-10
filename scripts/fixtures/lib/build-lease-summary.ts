import { Document, HeadingLevel, Packer, Paragraph } from 'docx';

import { DOCUMENT_AUTHOR } from './constants';
import { patchDocxCoreProps } from './patch-docx-core-props';
import { repackDeterministicZip } from './repack-zip';

export interface DocxParagraphManifest {
  index: number;
  style: 'Heading1' | 'Heading2' | 'Normal';
  text: string;
  // The heading hierarchy that owns this paragraph, derived from <w:pStyle> the same way the
  // downstream document.xml walk does (see docs/LEARNING_LOG.md #003 on why docx parsing reads
  // the XML directly rather than going through an HTML-rendering library). A heading paragraph
  // includes itself as the last element of its own path.
  headingPath: string[];
}

export interface BuiltDocx {
  buffer: Buffer;
  paragraphs: DocxParagraphManifest[];
}

interface ParagraphSpec {
  text: string;
  style: 'Heading1' | 'Heading2' | 'Normal';
}

// Exported (not module-private) so the synthetic-content sweep
// (test/fixtures/synthetic-content.spec.ts) can grep this module's literal strings directly
// rather than parsing the generated docx's zipped XML.
export const LEASE_SUMMARY_SPECS: ParagraphSpec[] = [
  { text: 'Lease Abstract — Northgate Business Park', style: 'Heading1' },
  {
    text:
      'This abstract summarizes the principal lease terms governing the anchor tenancy at ' +
      'Northgate Business Park. It is provided for underwriting reference and does not modify ' +
      'or supersede the executed lease agreement.',
    style: 'Normal',
  },
  { text: 'Premises', style: 'Heading2' },
  {
    text:
      'The premises consist of approximately 92,000 rentable square feet across Building A, ' +
      'Suites 100–450, together with 220 surface parking spaces and non-exclusive use of the ' +
      'shared loading area on the east side of the property.',
    style: 'Normal',
  },
  { text: 'Term', style: 'Heading2' },
  {
    text:
      'The initial lease term is ten years, commencing April 1, 2025 and expiring March 31, 2035, ' +
      'with no early termination right in favor of either party during the initial term.',
    style: 'Normal',
  },
  { text: 'Rent Schedule', style: 'Heading2' },
  {
    text:
      'Base rent commences at $34.50 per square foot in year one, escalating 3% annually on each ' +
      'anniversary of the commencement date. Rent is payable in equal monthly installments in ' +
      'advance.',
    style: 'Normal',
  },
  { text: 'Operating Expenses & Reimbursements', style: 'Heading2' },
  {
    text:
      'Tenant reimburses its pro rata share of operating expenses and real estate taxes on a ' +
      'triple-net basis, subject to a controllable-expense cap of 5% per annum on a cumulative, ' +
      'compounding basis.',
    style: 'Normal',
  },
  { text: 'Renewal Options', style: 'Heading2' },
  {
    text:
      'Tenant holds two successive five-year renewal options, exercisable at 95% of then-prevailing ' +
      "fair market rent, conditioned on twelve months' prior written notice and tenant not being in " +
      'monetary default at the time of exercise.',
    style: 'Normal',
  },
  { text: 'Tenant Covenants', style: 'Heading2' },
  {
    text:
      'The anchor tenant, Vantage Fulfillment Co., leases 62% of the net rentable area and is ' +
      'subject to a continuous-operation covenant requiring the premises to remain open for ' +
      'business during the entire initial term.',
    style: 'Normal',
  },
];

export async function buildLeaseSummary(): Promise<BuiltDocx> {
  const paragraphs: Paragraph[] = [];
  const manifest: DocxParagraphManifest[] = [];

  let currentH1: string | null = null;
  let currentH2: string | null = null;

  LEASE_SUMMARY_SPECS.forEach((spec, index) => {
    const heading =
      spec.style === 'Heading1'
        ? HeadingLevel.HEADING_1
        : spec.style === 'Heading2'
          ? HeadingLevel.HEADING_2
          : undefined;
    paragraphs.push(new Paragraph({ text: spec.text, heading }));

    if (spec.style === 'Heading1') {
      currentH1 = spec.text;
      currentH2 = null;
    } else if (spec.style === 'Heading2') {
      currentH2 = spec.text;
    }

    // A body paragraph's path is its nearest ancestor headings; a heading paragraph's path
    // ends with itself, since currentH1/currentH2 were already updated above.
    const headingPath = [currentH1, currentH2].filter((value): value is string => Boolean(value));

    manifest.push({ index, style: spec.style, text: spec.text, headingPath });
  });

  const document = new Document({
    creator: DOCUMENT_AUTHOR,
    lastModifiedBy: DOCUMENT_AUTHOR,
    title: 'Lease Abstract — Northgate Business Park',
    description: 'Synthetic evidence-ops fixture',
    revision: 1,
    sections: [{ children: paragraphs }],
  });

  const rawBuffer = await Packer.toBuffer(document);
  const buffer = await repackDeterministicZip(rawBuffer, patchDocxCoreProps);

  return { buffer, paragraphs: manifest };
}
