import ExcelJS from 'exceljs';

import { COMP_PROPERTIES, DOCUMENT_AUTHOR, FIXED_DOCUMENT_DATE } from './constants';
import { repackDeterministicZip } from './repack-zip';

const SHEET_NAME = 'Comps';
const HEADERS = [
  'Property Name',
  'Sale Date',
  'Building Area (SF)',
  'Sale Price (USD)',
  'Price per SF (USD)',
  'Cap Rate',
  'Net Operating Income (USD)',
  'Notes',
] as const;

export interface SheetManifest {
  name: string;
  headerRow: readonly string[];
  rowCount: number;
  usedRange: string;
}

export interface BuiltXlsx {
  buffer: Buffer;
  sheet: SheetManifest;
}

export async function buildCompsSheet(): Promise<BuiltXlsx> {
  const workbook = new ExcelJS.Workbook();
  // Pinned rather than left to default-to-now — required for byte-identical output across runs.
  workbook.creator = DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = DOCUMENT_AUTHOR;
  workbook.created = FIXED_DOCUMENT_DATE;
  workbook.modified = FIXED_DOCUMENT_DATE;

  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.columns = [
    { header: HEADERS[0], key: 'name', width: 30 },
    { header: HEADERS[1], key: 'saleDate', width: 14 },
    { header: HEADERS[2], key: 'buildingAreaSf', width: 18 },
    { header: HEADERS[3], key: 'salePriceUsd', width: 18 },
    { header: HEADERS[4], key: 'pricePerSf', width: 16 },
    { header: HEADERS[5], key: 'capRate', width: 12 },
    { header: HEADERS[6], key: 'noiUsd', width: 22 },
    { header: HEADERS[7], key: 'notes', width: 60 },
  ];

  for (const property of COMP_PROPERTIES) {
    const row = sheet.addRow({
      name: property.name,
      saleDate: property.saleDate,
      buildingAreaSf: property.buildingAreaSf,
      salePriceUsd: property.salePriceUsd,
      pricePerSf: property.pricePerSf,
      capRate: property.capRate,
      noiUsd: property.noiUsd,
      notes: property.notes,
    });
    row.getCell('buildingAreaSf').numFmt = '#,##0';
    row.getCell('salePriceUsd').numFmt = '$#,##0';
    row.getCell('pricePerSf').numFmt = '$#,##0.00';
    // Stored as a fraction (0.0525), displayed as 5.25% — this is the number-format branch
    // downstream code must distinguish a percentage cell by, not by the raw stored value.
    row.getCell('capRate').numFmt = '0.00%';
    row.getCell('noiUsd').numFmt = '$#,##0';
  }

  const rawBuffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  const buffer = await repackDeterministicZip(rawBuffer);

  const rowCount = COMP_PROPERTIES.length;
  const lastColumnLetter = String.fromCharCode('A'.charCodeAt(0) + HEADERS.length - 1);
  return {
    buffer,
    sheet: {
      name: SHEET_NAME,
      headerRow: HEADERS,
      rowCount,
      usedRange: `A1:${lastColumnLetter}${rowCount + 1}`,
    },
  };
}
