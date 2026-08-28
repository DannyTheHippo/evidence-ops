const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

const HEADERS = ['Vendor', 'Invoice Total (USD)'] as const;
const ROWS = [
  ['Meridian Facilities Group', '18450'],
  ['Northbridge Cleaning Co.', '6200'],
] as const;

/**
 * `utf16-export.csv`: BOM-prefixed UTF-16LE — the "Unicode Text" export Excel produces on Windows
 * when a user chooses File > Save As > "Unicode Text" rather than a UTF-8 CSV. Exercises
 * `decode-text-buffer.ts`'s BOM branch (`decodeTextBuffer`'s step 1), the deterministic half of its
 * UTF-16 handling — the BOM-less NUL-parity heuristic (step 2) is a separate, harder-to-fixture case
 * this file does not attempt.
 */
export function buildUtf16Export(): Buffer {
  const rows = [HEADERS.join(','), ...ROWS.map((row) => row.join(','))];
  const text = rows.join('\n') + '\n';
  return Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]);
}
