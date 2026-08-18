import { AREA_CONFLICT_PROPERTY, SEEDED_AREA_CONFLICT } from './constants';
import type { BuiltXlsx, SheetManifest } from './build-comps-sheet';

const SHEET_NAME = 'CSV';
const HEADERS = ['Property Name', 'Building Area (SF)'] as const;

/**
 * Builds `kestrel-point-crm-export.csv`: a one-row CRM deal export carrying the offering-
 * materials building area for `SEEDED_AREA_CONFLICT` — the least authoritative of that
 * conflict's three source classes (`metric-ontology.ts`'s `authorityOrder` for
 * `building_area_sf`). Plain UTF-8 text with LF line endings, no embedded metadata, mirroring
 * `build-noi-summary-csv.ts`'s determinism reasoning.
 */
export function buildKestrelPointCrmExport(): Promise<BuiltXlsx> {
  const row = `${AREA_CONFLICT_PROPERTY},${SEEDED_AREA_CONFLICT.crmValue.raw}`;
  const content = `${HEADERS.join(',')}\n${row}\n`;
  const buffer = Buffer.from(content, 'utf-8');

  const sheet: SheetManifest = {
    name: SHEET_NAME,
    headerRow: HEADERS,
    rowCount: 1,
    usedRange: 'A1:B2',
  };

  return Promise.resolve({ buffer, sheet });
}
