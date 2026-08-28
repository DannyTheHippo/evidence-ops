import ExcelJS from 'exceljs';
import { DOCUMENT_AUTHOR, FIXED_DOCUMENT_DATE } from './constants';
import { repackDeterministicZip } from '../../lib/repack-zip';

const SHEET_NAME = 'Reconciliation';

// `xlsx.parser.ts`'s `formatNumber` explicitly documents the two-section accounting shape
// (`#,##0;(#,##0)`, positive;negative, parens instead of a minus sign) as supported. This format
// is that shape, applied to a genuinely negative value — the case the parser's own comment names.
const TWO_SECTION_ACCOUNTING_FORMAT = '#,##0.00;(#,##0.00)';

// The real four-section Excel "Accounting" number format
// (positive;negative;zero;text) — what a spreadsheet application actually writes when a user
// picks the built-in Accounting format in the number-format gallery. `formatNumber` only reads
// sections 0 and 1 (see its own source), so this column is deliberately included to observe —
// not assert in advance — what a two-section-only implementation does with a value that only a
// third (zero) section was meant to format. See `test/fixtures/adversarial-behavior.spec.ts` for
// the actually-observed output.
const FOUR_SECTION_ACCOUNTING_FORMAT = '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-';

const ROWS = [
  { item: 'Base Rent', amount: 12_500 },
  { item: 'Tenant Improvement Allowance', amount: -3_200.5 },
  { item: 'Reconciliation Adjustment', amount: 0 },
] as const;

export async function buildAccountingNegativeSheet(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = DOCUMENT_AUTHOR;
  workbook.lastModifiedBy = DOCUMENT_AUTHOR;
  workbook.created = FIXED_DOCUMENT_DATE;
  workbook.modified = FIXED_DOCUMENT_DATE;

  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.addRow(['Item', 'Amount (two-section)', 'Amount (four-section accounting)']);

  for (const row of ROWS) {
    const added = sheet.addRow([row.item, row.amount, row.amount]);
    added.getCell(2).numFmt = TWO_SECTION_ACCOUNTING_FORMAT;
    added.getCell(3).numFmt = FOUR_SECTION_ACCOUNTING_FORMAT;
  }

  const rawBuffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  return repackDeterministicZip(rawBuffer);
}
