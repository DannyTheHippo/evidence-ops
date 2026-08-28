// The WHATWG `index-windows-1252` mapping for the handful of bytes this fixture needs — the
// encoder half of `decode-text-buffer.ts`'s `WINDOWS_1252_HIGH_RANGE` table, kept tiny rather than
// general: this fixture only needs an accented Latin-1-range letter and one 0x80-0x9F byte to
// prove the decoder's cp1252 branch, not a full round-trip codec.
const CODE_POINT_TO_CP1252_BYTE: ReadonlyMap<number, number> = new Map([
  [0x2014, 0x97], // em dash — outside Latin-1, only reachable via the 0x80-0x9F high range.
  [0x2019, 0x92], // right single quotation mark — ditto.
]);

/** Encodes a string to raw cp1252 bytes. Every code point below 0x100 is byte-identical to cp1252
 *  (Latin-1 equivalence, mirroring `decodeWindows1252`'s own decode-side comment); anything else
 *  must be in `CODE_POINT_TO_CP1252_BYTE` or this throws — a silent lossy fallback would defeat the
 *  fixture's purpose, which is to be genuinely cp1252, not ASCII wearing a cp1252 label. */
function encodeWindows1252(text: string): Buffer {
  const bytes = Uint8Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error(`Unpaired surrogate in fixture text: ${JSON.stringify(text)}`);
    }
    if (codePoint < 0x100) {
      return codePoint;
    }
    const mapped = CODE_POINT_TO_CP1252_BYTE.get(codePoint);
    if (mapped === undefined) {
      throw new Error(`No cp1252 byte mapped for U+${codePoint.toString(16)}`);
    }
    return mapped;
  });
  return Buffer.from(bytes);
}

const HEADERS = ['Tenant Name', 'Notes'] as const;

/**
 * `windows-1252-export.csv`: a comma-delimited CRM-style export carrying an em dash and a curly
 * apostrophe, the two characters this fixture tree uses to exercise `decode-text-buffer.ts`'s
 * cp1252 fallback branch — reached only once strict UTF-8 decoding and the BOM-less UTF-16
 * NUL-parity heuristic have both been ruled out (see that module's own doc comment on why order
 * matters). No BOM and no non-ASCII byte pattern a UTF-16 heuristic could mistake for text, so this
 * lands on the cp1252 branch deterministically.
 */
export function buildWindows1252Csv(): Buffer {
  const rows = [
    HEADERS.join(','),
    `Café Meridian — Reception Desk,Tenant’s renewal option lapses next quarter`,
  ];
  return encodeWindows1252(rows.join('\n') + '\n');
}
