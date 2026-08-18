import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AREA_CONFLICT_PROPERTY,
  AREA_CONFLICT_PROPERTY_ALIAS,
  CANARY_MARKERS,
  COMP_PROPERTIES,
  DOCUMENT_AUTHOR,
} from '../../scripts/fixtures/lib/constants';
import { COMP_EXTRACT_PAGES } from '../../scripts/fixtures/lib/build-kestrel-point-comp-extract';
import { LEASE_SUMMARY_SPECS } from '../../scripts/fixtures/lib/build-lease-summary';
import { MARKET_OVERVIEW_PAGES } from '../../scripts/fixtures/lib/build-market-overview';
import { VALUATION_MEMO_PAGES } from '../../scripts/fixtures/lib/build-valuation-memo';

const DATA_ROOM_DIR = path.join(__dirname, '../../fixtures/data-room');

// Real-world commercial real estate brokerages/investors and real city names — none of these
// may appear anywhere in the corpus, since it ships in a public portfolio repo and every
// property, firm, and locale in it must be invented. Extend this list rather than loosen the
// check if a new category of real-world identifier needs guarding against.
const DENYLIST = [
  'CBRE',
  'Cushman & Wakefield',
  'Cushman',
  'JLL',
  'Jones Lang LaSalle',
  'Colliers',
  'Newmark',
  'Marcus & Millichap',
  'Eastdil',
  'Blackstone',
  'Brookfield',
  'Prologis',
  'Starwood Capital',
  'Simon Property',
  'Vornado',
  'Boston Properties',
  'Hines',
  'Related Companies',
  'Tishman Speyer',
  'New York',
  'Manhattan',
  'Los Angeles',
  'Chicago',
  'Dallas',
  'Houston',
  'Atlanta',
  'Phoenix',
  'Miami',
  'Seattle',
  'Boston',
  'San Francisco',
  'Denver',
  'Austin',
  'Nashville',
  'Charlotte',
  'Philadelphia',
];

// The authored source strings are the ground truth for what ends up embedded in the generated
// binaries — grepping them directly is exhaustive and reliable, unlike grepping the generated
// PDFs, whose content streams pdfkit compresses (FlateDecode) by default, which would make a
// raw byte search silently miss real text without proving anything about its absence.
function collectAuthoredStrings(): string[] {
  const strings: string[] = [DOCUMENT_AUTHOR, AREA_CONFLICT_PROPERTY, AREA_CONFLICT_PROPERTY_ALIAS];

  for (const property of COMP_PROPERTIES) {
    strings.push(property.name, property.notes);
  }

  for (const canary of Object.values(CANARY_MARKERS)) {
    strings.push(canary.description);
  }

  for (const page of [...VALUATION_MEMO_PAGES, ...MARKET_OVERVIEW_PAGES, ...COMP_EXTRACT_PAGES]) {
    strings.push(page.heading, ...page.paragraphs);
  }

  for (const spec of LEASE_SUMMARY_SPECS) {
    strings.push(spec.text);
  }

  return strings;
}

describe('synthetic-content sweep', () => {
  it('should not contain any denylisted real-world identifier in authored fixture content', () => {
    const haystack = collectAuthoredStrings().join('\n').toLowerCase();
    const hits = DENYLIST.filter((term) => haystack.includes(term.toLowerCase()));
    expect(hits).toEqual([]);
  });

  it('should not contain any denylisted real-world identifier in the generated binaries', async () => {
    // Defense in depth on top of the source-content check above: xlsx/docx are zipped XML and
    // this catches those in full; PDF text is compressed and this pass over it is best-effort
    // (see rationale on collectAuthoredStrings above) rather than the source of truth.
    const fileNames = await readdir(DATA_ROOM_DIR);
    const hits: string[] = [];
    for (const fileName of fileNames) {
      const buffer = await readFile(path.join(DATA_ROOM_DIR, fileName));
      const text = buffer.toString('latin1').toLowerCase();
      for (const term of DENYLIST) {
        if (text.includes(term.toLowerCase())) {
          hits.push(`${fileName}: ${term}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
