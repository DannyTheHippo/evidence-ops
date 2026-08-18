import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AREA_CONFLICT_ALIAS_VALUE,
  CANARY_MARKERS,
  COMP_PROPERTIES,
  SEEDED_AREA_CONFLICT,
  SEEDED_CONFLICT,
  SEEDED_NOI_CONFLICT,
} from '../../scripts/fixtures/lib/constants';
import { COMP_EXTRACT_PAGES } from '../../scripts/fixtures/lib/build-kestrel-point-comp-extract';
import { LEASE_SUMMARY_SPECS } from '../../scripts/fixtures/lib/build-lease-summary';
import { MARKET_OVERVIEW_PAGES } from '../../scripts/fixtures/lib/build-market-overview';
import { sha256Hex } from '../../scripts/fixtures/lib/hash';
import { VALUATION_MEMO_PAGES } from '../../scripts/fixtures/lib/build-valuation-memo';
import manifest from '../../fixtures/data-room/manifest.json';

const DATA_ROOM_DIR = path.join(__dirname, '../../fixtures/data-room');

/**
 * manifest.json is what downstream tests read instead of hardcoding facts about the corpus
 * (per the task brief). This spec is what keeps that trust warranted: every sha256 must match
 * the committed bytes, the conflict record must match what the source content actually says on
 * each side, and both canary tokens must actually be present where the manifest claims.
 */
describe('fixtures/data-room/manifest.json integrity', () => {
  it('should record the correct sha256 for every committed binary', async () => {
    for (const [fileName, entry] of Object.entries(manifest.files)) {
      const buffer = await readFile(path.join(DATA_ROOM_DIR, fileName));
      expect(sha256Hex(buffer)).toBe(entry.sha256);
    }
  });

  it('should record the seeded cap-rate conflict values consistently with the authored content', () => {
    const northgate = COMP_PROPERTIES.find(
      (property) => property.name === SEEDED_CONFLICT.property,
    );
    expect(northgate).toBeDefined();
    expect(northgate?.capRate).toBe(SEEDED_CONFLICT.sheetValue.raw);
    expect(manifest.conflicts[0].locations[0].value).toBe(SEEDED_CONFLICT.sheetValue.raw);
    expect(manifest.conflicts[0].locations[0].display).toBe(SEEDED_CONFLICT.sheetValue.display);

    const memoText = VALUATION_MEMO_PAGES.flatMap((page) => page.paragraphs).join(' ');
    expect(memoText).toContain(SEEDED_CONFLICT.memoValue.display);
    expect(manifest.conflicts[0].locations[1].display).toBe(SEEDED_CONFLICT.memoValue.display);

    // The two values must genuinely differ — a "conflict" where both sides agree is not a conflict.
    expect(SEEDED_CONFLICT.sheetValue.display).not.toBe(SEEDED_CONFLICT.memoValue.display);
  });

  it('should record the seeded NOI conflict values consistently with the authored content', () => {
    const fenwick = COMP_PROPERTIES.find(
      (property) => property.name === SEEDED_NOI_CONFLICT.property,
    );
    expect(fenwick).toBeDefined();
    expect(fenwick?.noiUsd).toBe(SEEDED_NOI_CONFLICT.sheetValue.raw);
    expect(manifest.conflicts[1].locations[0].value).toBe(SEEDED_NOI_CONFLICT.sheetValue.raw);
    expect(manifest.conflicts[1].locations[0].display).toBe(SEEDED_NOI_CONFLICT.sheetValue.display);
    expect(manifest.conflicts[1].locations[1].value).toBe(SEEDED_NOI_CONFLICT.csvValue.raw);
    expect(manifest.conflicts[1].locations[1].display).toBe(SEEDED_NOI_CONFLICT.csvValue.display);

    // The two values must genuinely differ — a "conflict" where both sides agree is not a conflict.
    expect(SEEDED_NOI_CONFLICT.sheetValue.display).not.toBe(SEEDED_NOI_CONFLICT.csvValue.display);
  });

  it('should record the seeded building-area conflict values consistently with the authored content', () => {
    // Canonical-entity resolution folds `kestrel-point-flyer-export.csv`'s alias-named row into
    // this same group, so the conflict is four locations, not three — a regression here would
    // silently understate the group again (see `constants.ts`'s `AREA_CONFLICT_ALIAS_VALUE` doc
    // comment).
    expect(manifest.conflicts[2].locations).toHaveLength(4);

    expect(manifest.conflicts[2].locations[0].value).toBe(SEEDED_AREA_CONFLICT.pmValue.raw);
    expect(manifest.conflicts[2].locations[0].display).toBe(SEEDED_AREA_CONFLICT.pmValue.display);
    // The middle location is a PDF page, not an xlsx cell — it carries `display`/`context`, no
    // numeric `value` (see `PdfConflictLocation` in `build-manifest.ts`).
    expect(manifest.conflicts[2].locations[1].display).toBe(
      SEEDED_AREA_CONFLICT.spreadsheetValue.display,
    );
    expect(manifest.conflicts[2].locations[2].value).toBe(SEEDED_AREA_CONFLICT.crmValue.raw);
    expect(manifest.conflicts[2].locations[2].display).toBe(SEEDED_AREA_CONFLICT.crmValue.display);
    expect(manifest.conflicts[2].locations[3].value).toBe(AREA_CONFLICT_ALIAS_VALUE.raw);
    expect(manifest.conflicts[2].locations[3].display).toBe(AREA_CONFLICT_ALIAS_VALUE.display);

    const compExtractText = COMP_EXTRACT_PAGES.flatMap((page) => page.paragraphs).join(' ');
    expect(compExtractText).toContain(SEEDED_AREA_CONFLICT.spreadsheetValue.display);

    // All four values must genuinely differ from one another — sides "agreeing" pairwise would
    // not be a conflict.
    const displays = [
      SEEDED_AREA_CONFLICT.pmValue.display,
      SEEDED_AREA_CONFLICT.spreadsheetValue.display,
      SEEDED_AREA_CONFLICT.crmValue.display,
      AREA_CONFLICT_ALIAS_VALUE.display,
    ];
    expect(new Set(displays).size).toBe(displays.length);
  });

  it('should have both canary tokens actually present where the manifest says they are', () => {
    const northgateCanaryHolder = COMP_PROPERTIES.find((property) =>
      property.notes.includes(CANARY_MARKERS.xlsx.token),
    );
    expect(northgateCanaryHolder).toBeDefined();
    expect(manifest.canaries.find((c) => c.token === CANARY_MARKERS.xlsx.token)?.file).toBe(
      CANARY_MARKERS.xlsx.file,
    );

    const marketOverviewText = MARKET_OVERVIEW_PAGES.flatMap((page) => page.paragraphs).join(' ');
    expect(marketOverviewText).toContain(CANARY_MARKERS.pdf.token);
    expect(manifest.canaries.find((c) => c.token === CANARY_MARKERS.pdf.token)?.file).toBe(
      CANARY_MARKERS.pdf.file,
    );
  });

  it('should describe every docx paragraph consistently with the authored spec order', () => {
    expect(manifest.files['lease-summary.docx'].paragraphs).toHaveLength(
      LEASE_SUMMARY_SPECS.length,
    );
    manifest.files['lease-summary.docx'].paragraphs.forEach((paragraph, index) => {
      expect(paragraph.text).toBe(LEASE_SUMMARY_SPECS[index].text);
    });
  });
});
