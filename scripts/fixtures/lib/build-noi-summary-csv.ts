import { COMP_PROPERTIES } from './constants';
import type { BuiltXlsx, SheetManifest } from './build-comps-sheet';

const SHEET_NAME = 'CSV';
const HEADERS = ['Property Name', 'Sale Date', 'Net Operating Income (USD)'] as const;

/**
 * Net operating income overrides, keyed by property name, for rows whose noi-summary.csv figure
 * is deliberately seeded to disagree with comps.xlsx — see `build-manifest.ts`'s
 * `SEEDED_NOI_CONFLICT` for the paired manifest record both sides describe. Every property not
 * listed here copies its comps.xlsx `noiUsd` value exactly, so no accidental second conflict
 * appears in the fixture.
 */
const NOI_OVERRIDE: Readonly<Record<string, number>> = {
  'Fenwick Distribution Hub': 4_150_000,
};

/**
 * Builds `noi-summary.csv`: a minimal three-column NOI extract of the same ten comparable-sale
 * properties as `build-comps-sheet.ts`, in the same row order, so `entity` + `period` fact keys
 * line up between the two sources. Plain UTF-8 text with LF line endings and no embedded
 * metadata — unlike the xlsx/docx/pdf builders, a delimited-text file carries no document
 * properties for `pin-timezone.ts`'s TZ pin to matter to, so byte-identical output across runs
 * needs nothing beyond building the same string every time.
 */
export function buildNoiSummaryCsv(): Promise<BuiltXlsx> {
  const rows = COMP_PROPERTIES.map((property) => {
    const noi = NOI_OVERRIDE[property.name] ?? property.noiUsd;
    return `${property.name},${property.saleDate},${noi}`;
  });
  const content = `${HEADERS.join(',')}\n${rows.join('\n')}\n`;
  const buffer = Buffer.from(content, 'utf-8');

  const rowCount = COMP_PROPERTIES.length;
  const sheet: SheetManifest = {
    name: SHEET_NAME,
    headerRow: HEADERS,
    rowCount,
    usedRange: `A1:C${rowCount + 1}`,
  };

  return Promise.resolve({ buffer, sheet });
}
