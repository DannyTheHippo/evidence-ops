import { AREA_CONFLICT_ALIAS_VALUE, AREA_CONFLICT_PROPERTY_ALIAS } from './constants';
import type { BuiltXlsx, SheetManifest } from './build-comps-sheet';

const SHEET_NAME = 'CSV';
const HEADERS = ['Property Name', 'Building Area (SF)'] as const;

/**
 * Builds `kestrel-point-flyer-export.csv`: a one-row CRM export for the same property as
 * `SEEDED_AREA_CONFLICT`, but under `AREA_CONFLICT_PROPERTY_ALIAS` — the abbreviated form a
 * marketing flyer or a hand-entered CRM record would use. `CANONICAL_ENTITY_SEED` is the registry
 * row that maps this alias back to `AREA_CONFLICT_PROPERTY`; `FactsService.extractFacts`
 * canonicalizes against it before grouping, so `detectConflicts` folds this row's fact into the
 * same group as the other three `kestrel-point-*` documents (see `constants.ts`'s
 * `AREA_CONFLICT_ALIAS_VALUE` doc comment).
 */
export function buildKestrelPointFlyerExport(): Promise<BuiltXlsx> {
  const row = `${AREA_CONFLICT_PROPERTY_ALIAS},${AREA_CONFLICT_ALIAS_VALUE.raw}`;
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
