import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CANARY_MARKERS,
  COMP_PROPERTIES,
  SEEDED_CONFLICT,
} from '../../scripts/fixtures/lib/constants';
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

  it('should record the seeded conflict values consistently with the authored content', () => {
    const northgate = COMP_PROPERTIES.find(
      (property) => property.name === SEEDED_CONFLICT.property,
    );
    expect(northgate).toBeDefined();
    expect(northgate?.capRate).toBe(SEEDED_CONFLICT.sheetValue.raw);
    expect(manifest.conflict.locations[0].value).toBe(SEEDED_CONFLICT.sheetValue.raw);
    expect(manifest.conflict.locations[0].display).toBe(SEEDED_CONFLICT.sheetValue.display);

    const memoText = VALUATION_MEMO_PAGES.flatMap((page) => page.paragraphs).join(' ');
    expect(memoText).toContain(SEEDED_CONFLICT.memoValue.display);
    expect(manifest.conflict.locations[1].display).toBe(SEEDED_CONFLICT.memoValue.display);

    // The two values must genuinely differ — a "conflict" where both sides agree is not a conflict.
    expect(SEEDED_CONFLICT.sheetValue.display).not.toBe(SEEDED_CONFLICT.memoValue.display);
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
