import ExcelJS from 'exceljs';
import { DOCUMENT_AUTHOR, FIXED_DOCUMENT_DATE } from './constants';
import { repackDeterministicZip } from '../../lib/repack-zip';

const SHEET_NAME = 'Suite Detail';

// Row 1: a category band, each category repeated across the columns it groups — the shape a
// spreadsheet author gets from merging cells without actually using Excel's merge feature (a
// common paste-from-another-tool artifact). Row 2: the real field names. `sheet-header.ts`'s
// `resolveHeaderRow` is what decides which of the two a reader (and this fixture's own spec) sees
// as the header — deliberately not asserted here, only generated; see the fixture manifest for
// what it actually resolves to.
const CATEGORY_ROW = ['Suite Detail', 'Suite Detail', 'Financials', 'Financials'] as const;
const FIELD_ROW = ['Suite', 'Tenant', 'Monthly Rent (USD)', 'Lease Expiry'] as const;
const DATA_ROWS = [
  ['201', 'Aldercrest Consulting', 5400, '2027-01-31'],
  ['202', 'Birchwood Analytics', 4750, '2026-09-30'],
  ['203', 'Cinderpoint Legal', 6100, '2028-02-29'],
] as const;

export async function buildTwoRowHeaderSheet(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = DOCUMENT_AUTHOR;
  workbook.created = FIXED_DOCUMENT_DATE;
  workbook.modified = FIXED_DOCUMENT_DATE;

  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.addRow([...CATEGORY_ROW]);
  sheet.addRow([...FIELD_ROW]);
  for (const row of DATA_ROWS) {
    sheet.addRow([...row]);
  }

  const rawBuffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  return repackDeterministicZip(rawBuffer);
}
