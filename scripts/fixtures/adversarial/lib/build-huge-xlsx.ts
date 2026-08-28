import ExcelJS from 'exceljs';
import { DOCUMENT_AUTHOR, FIXED_DOCUMENT_DATE } from './constants';

const SHEET_NAME = 'Extract';
const HEADERS = ['Row ID', 'Reading'] as const;

/**
 * Builds an ~100k-row, two-column xlsx entirely in memory — never written to `fixtures/adversarial`
 * and never repacked through `repackDeterministicZip`: byte-determinism only matters for committed
 * files, and this one is multi-megabyte and regenerated fresh by every caller instead. Row count
 * is a parameter (not a constant) so `test/fixtures/adversarial-behavior.spec.ts` can find the
 * budget's actual boundary rather than only prove one fixed row count trips it.
 *
 * At the default row count this trips `MAX_TOTAL_EMITTED_ELEMENTS` (20,000 emitted elements — two
 * ordinary columns cross that at 10,000 rows) well before it reaches
 * `MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES` (25 MB of declared worksheet XML); see
 * `buildWideCellWorksheetByteBudgetXlsx` below for a fixture that trips the byte budget instead.
 * `assertWithinEmittedElementBudget`'s own refusal is `HostileArchiveException`, not
 * `MalformedXlsxException` — see `test/fixtures/adversarial-behavior.spec.ts` for what that means
 * for an operator's own honestly-oversized data room.
 */
export async function buildHundredKRowXlsx(rowCount = 100_000): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = DOCUMENT_AUTHOR;
  workbook.created = FIXED_DOCUMENT_DATE;
  workbook.modified = FIXED_DOCUMENT_DATE;

  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.addRow([...HEADERS]);
  for (let rowId = 1; rowId <= rowCount; rowId += 1) {
    sheet.addRow([rowId, Math.round(Math.sin(rowId) * 1_000_000) / 1_000]);
  }

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

// Long enough that `rowCount` cells of this length alone clear 25 MB well before `rowCount`
// approaches `MAX_TOTAL_EMITTED_ELEMENTS` (20,000) — the inverse shape of `buildHundredKRowXlsx`:
// few elements, wide cells, so the worksheet-byte budget is what trips, not the element-count one.
const WIDE_CELL_LENGTH = 2_200;

/**
 * A single-column sheet of `rowCount` cells, each `WIDE_CELL_LENGTH` characters of repeated-`x`
 * filler text — an attempt to clear `MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES` (25 MB of declared
 * worksheet XML) while staying under `MAX_TOTAL_EMITTED_ELEMENTS` (20,000), the budget
 * `buildHundredKRowXlsx` trips instead. In practice it does not reach that budget: the repeated
 * filler compresses far past `safe-zip.ts`'s 100:1 ratio guard, which throws
 * `HostileArchiveException` first — see `test/fixtures/adversarial-behavior.spec.ts`'s own finding
 * on this. Also in-memory only, for the same reason as `buildHundredKRowXlsx`.
 */
export async function buildWideCellWorksheetByteBudgetXlsx(rowCount = 15_000): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = DOCUMENT_AUTHOR;
  workbook.created = FIXED_DOCUMENT_DATE;
  workbook.modified = FIXED_DOCUMENT_DATE;

  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.addRow(['Notes']);
  const filler = 'x'.repeat(WIDE_CELL_LENGTH);
  for (let rowId = 1; rowId <= rowCount; rowId += 1) {
    sheet.addRow([`${filler}-${rowId}`]);
  }

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
