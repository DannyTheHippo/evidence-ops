import ExcelJS from 'exceljs';

import {
  AREA_CONFLICT_PROPERTY,
  DOCUMENT_AUTHOR,
  FIXED_DOCUMENT_DATE,
  SEEDED_AREA_CONFLICT,
} from './constants';
import { repackDeterministicZip } from './repack-zip';
import type { BuiltXlsx, SheetManifest } from './build-comps-sheet';

const SHEET_NAME = 'Rent Roll';
const HEADERS = ['Property Name', 'Building Area (SF)'] as const;

/**
 * Builds `kestrel-point-pm-export.xlsx`: a one-row property-management rent roll extract
 * carrying `SEEDED_AREA_CONFLICT`'s `pm-export` figure — the highest-ranked source class in
 * `metric-ontology.ts`'s `authorityOrder` for `building_area_sf`, so this is the value
 * `resolve-conflict-policy.ts` proposes as the winner. Mirrors `build-comps-sheet.ts`'s
 * ExcelJS + `repackDeterministicZip` pattern for byte-identical output across runs.
 */
export async function buildKestrelPointPmExport(): Promise<BuiltXlsx> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = DOCUMENT_AUTHOR;
  workbook.created = FIXED_DOCUMENT_DATE;
  workbook.modified = FIXED_DOCUMENT_DATE;

  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.columns = [
    { header: HEADERS[0], key: 'name', width: 30 },
    { header: HEADERS[1], key: 'buildingAreaSf', width: 18 },
  ];

  const row = sheet.addRow({
    name: AREA_CONFLICT_PROPERTY,
    buildingAreaSf: SEEDED_AREA_CONFLICT.pmValue.raw,
  });
  row.getCell('buildingAreaSf').numFmt = '#,##0';

  const rawBuffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  const buffer = await repackDeterministicZip(rawBuffer);

  const sheetManifest: SheetManifest = {
    name: SHEET_NAME,
    headerRow: HEADERS,
    rowCount: 1,
    usedRange: 'A1:B2',
  };

  return { buffer, sheet: sheetManifest };
}
