const HEADERS = ['Suite', 'Monthly Rent (USD)', 'Lease Expiry'] as const;

const ROWS = [
  ['101', '4200', '2027-03-31'],
  ['102', '3100', '2026-11-30'],
  ['103', '5600', '2028-06-30'],
] as const;

/**
 * `semicolon-export.csv`: plain UTF-8, `;`-delimited — the shape a European-locale spreadsheet
 * export produces when its own decimal separator is a comma, so the field delimiter moves to a
 * semicolon to stay unambiguous. Exercises `csv.parser.ts`'s `SNIFFABLE_DELIMITER` detection
 * against a well-formed file (no embedded delimiter-shaped content inside a field, so sniffing has
 * nothing ambiguous to resolve).
 */
export function buildSemicolonCsv(): Buffer {
  const rows = [HEADERS.join(';'), ...ROWS.map((row) => row.join(';'))];
  return Buffer.from(rows.join('\n') + '\n', 'utf-8');
}
