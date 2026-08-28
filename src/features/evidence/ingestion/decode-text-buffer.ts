/** Every encoding this module can produce — the input side of `TextParser`/`CsvParser`, which
 * otherwise have no way to recover from a source that is not UTF-8. */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

/** Swaps every adjacent byte pair — turns a big-endian UTF-16 buffer into the little-endian layout
 * `Buffer#toString('utf16le')` requires, since Node has no native big-endian decoder. A trailing
 * odd byte (a malformed/truncated BE stream) is dropped rather than paired with a phantom zero: a
 * single stray byte cannot decode to a real code unit either way. */
function swapBytePairs(buffer: Buffer): Buffer {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.alloc(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped;
}

function tryDecodeStrictUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

// Below this length, one incidental control character is as plausibly genuine content — a literal
// NUL in an otherwise-ordinary short ASCII buffer, which this heuristic must not misclassify — as
// it is a misread UTF-16 stream; too few characters for a single occurrence to mean anything.
const MIN_LENGTH_FOR_CONTROL_CHARACTER_CHECK = 16;

// A BOM-less UTF-16 stream whose code units keep both bytes below 0x80 (dense non-Latin text with
// few 0x00 halves — Cyrillic, Greek, Hebrew, Devanagari, Thai code points frequently land here) is
// valid strict UTF-8 taken byte-by-byte: `detectBomlessUtf16` finds no parity signal, and
// `tryDecodeStrictUtf8` "succeeds" with a string of two characters per real one. Genuine UTF-8
// prose essentially never carries a C0/C1 control code point outside common whitespace, so their
// presence here — at a length past `MIN_LENGTH_FOR_CONTROL_CHARACTER_CHECK` — is stronger evidence
// of a misread UTF-16 stream than of an actual control character in the source.
function hasUnexpectedControlCharacters(text: string): boolean {
  if (text.length < MIN_LENGTH_FOR_CONTROL_CHARACTER_CHECK) {
    return false;
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isCommonWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if (!isCommonWhitespace && ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f))) {
      return true;
    }
  }
  return false;
}

// A BOM-less UTF-16 stream (Excel's plain "Unicode Text" export can omit one) still carries its
// tell: every ASCII code unit spends one whole byte on a 0x00 high (BE) or low (LE) half. Fewer
// than this fraction of one parity being 0x00 means the buffer is not densely-ASCII UTF-16 at all
// — most plausibly single-byte text with the occasional literal NUL, which this heuristic must not
// misclassify.
const UTF16_NUL_PARITY_THRESHOLD = 0.4;

// Below this many pairs, a ratio alone is too little evidence: with 2 pairs, a single incidental
// NUL byte already clears 0.4. Below this size the parity must be unanimous, whatever `minRatio`
// the caller asked for — there are too few samples for a ratio to mean anything statistically.
const UTF16_NUL_PARITY_MIN_PAIRS_FOR_RATIO = 16;

/** Infers little-endian vs. big-endian from which byte parity carries the 0x00 halves, or
 * `undefined` when neither parity clears `minRatio` (default `UTF16_NUL_PARITY_THRESHOLD`) — the
 * buffer is not BOM-less UTF-16. A buffer with fewer than `UTF16_NUL_PARITY_MIN_PAIRS_FOR_RATIO`
 * pairs needs unanimous parity instead, regardless of `minRatio`. */
function detectBomlessUtf16(
  buffer: Buffer,
  minRatio: number = UTF16_NUL_PARITY_THRESHOLD,
): 'utf-16le' | 'utf-16be' | undefined {
  if (buffer.length < 4) {
    return undefined;
  }

  let nulAtEven = 0;
  let nulAtOdd = 0;
  const pairCount = Math.floor(buffer.length / 2);
  for (let i = 0; i < pairCount * 2; i += 2) {
    if (buffer[i] === 0x00) nulAtEven += 1;
    if (buffer[i + 1] === 0x00) nulAtOdd += 1;
  }

  const evenRatio = nulAtEven / pairCount;
  const oddRatio = nulAtOdd / pairCount;
  const requiredRatio = pairCount < UTF16_NUL_PARITY_MIN_PAIRS_FOR_RATIO ? 1 : minRatio;

  // LE stores the low byte first, so a NUL high byte lands at the odd position; BE is the mirror.
  if (oddRatio >= requiredRatio && oddRatio > evenRatio) {
    return 'utf-16le';
  }
  if (evenRatio >= requiredRatio && evenRatio > oddRatio) {
    return 'utf-16be';
  }
  return undefined;
}

// The WHATWG `index-windows-1252` table for byte range 0x80-0x9F — the one span where cp1252
// diverges from ISO-8859-1/Latin-1. A byte the standard leaves unassigned (0x81, 0x8D, 0x8F, 0x90,
// 0x9D) maps to its own C1-control code point rather than being rejected, matching every browser's
// windows-1252 decoder: this is the fallback of a fallback, so it fails OPEN to "keep the byte's
// own value" rather than lose or replace it.
const WINDOWS_1252_HIGH_RANGE: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

/** Byte-for-byte cp1252 decode: 0x00-0x7F and 0xA0-0xFF are identical to their own code point
 * (Latin-1 equivalence), 0x80-0x9F consult `WINDOWS_1252_HIGH_RANGE`. The final fallback once a
 * buffer has already failed strict UTF-8 and the BOM-less UTF-16 heuristic — every single-byte
 * Western European export this project has seen land in production is cp1252, not the rarer
 * ISO-8859-1 it is a superset of. */
function decodeWindows1252(buffer: Buffer): string {
  let result = '';
  for (const byte of buffer) {
    if (byte >= 0x80 && byte <= 0x9f) {
      result += String.fromCharCode(WINDOWS_1252_HIGH_RANGE[byte] ?? byte);
    } else {
      result += String.fromCharCode(byte);
    }
  }
  return result;
}

// `Buffer#toString('utf16le')` pairs bytes mechanically — a truncated or malformed stream can
// leave a lone surrogate in the result, which has no valid UTF-8 encoding. That would desync the
// content-addressed chunk id (hashed as UTF-8 downstream) from the string actually stored, so
// every UTF-16 decode is normalized through `toWellFormed()` before it leaves this module; it is a
// no-op on an already-well-formed string.
function decodeUtf16le(bytes: Buffer): string {
  return bytes.toString('utf16le').toWellFormed();
}

// Overriding an explicit BOM needs stronger evidence than an unassisted guess does: a body
// legitimately dense in U+XX00 code points (common CJK ideographs among them, `U+4E00` most of
// all) puts a real NUL half on the opposite parity with no endianness disagreement at all, so the
// 0.4 bar that is safe for a blind guess would flip a correctly-labelled document. Only near-total
// contradiction — the signature of a genuinely mislabelled stream, whose ASCII-range code units
// land NUL on one parity almost without exception — overrides a declared BOM.
const UTF16_DECLARED_OVERRIDE_THRESHOLD = 0.85;

/**
 * Decodes the body of a buffer whose UTF-16 BOM declared `declared`, holding that declaration
 * unless the content's NUL parity overwhelmingly names the other endianness
 * (`UTF16_DECLARED_OVERRIDE_THRESHOLD`) — anything weaker is not a safe basis to override an
 * explicit declaration, only to make a blind guess in its absence.
 *
 * Almost every even-length buffer is a valid UTF-16 string, so there is no validity test to fail,
 * and the ladder that resolves an unmarked buffer cannot separate single-byte content from genuine
 * dense non-ASCII UTF-16: a CJK buffer carries too few NUL halves for the parity heuristic to
 * read, and its code units are ordinary UTF-8 bytes taken singly (`U+4E2D` little-endian is
 * `2D 4E`, which strict UTF-8 accepts as `-N`). Falling through there would corrupt real UTF-16
 * documents in order to repair mislabelled ones.
 */
function decodeDeclaredUtf16(body: Buffer, declared: 'utf-16le' | 'utf-16be'): DecodedText {
  const detected = detectBomlessUtf16(body, UTF16_DECLARED_OVERRIDE_THRESHOLD);
  const encoding = detected !== undefined && detected !== declared ? detected : declared;
  return {
    text: decodeUtf16le(encoding === 'utf-16be' ? swapBytePairs(body) : body),
    encoding,
  };
}

/**
 * Decodes a raw upload buffer into text, detecting the source encoding rather than assuming
 * UTF-8 — and rather than trusting a BOM, which records what the author's tool intended, not what
 * the bytes are. Order matters, each step narrowing what remains unclassified:
 *
 * 1. Every leading UTF-8 BOM is stripped and the remainder decoded by the rest of this ladder, so a
 *    BOM-prefixed buffer resolves to exactly what the identical unmarked bytes resolve to. The
 *    declaration survives only by agreeing with step 4; a "CSV UTF-8" export carrying a cp1252 or
 *    UTF-16 body lands on its real encoding instead of on U+FFFD replacements.
 * 2. A UTF-16 BOM is authoritative except against a contradicting NUL parity (`decodeDeclaredUtf16`).
 * 3. No BOM: check for BOM-less UTF-16 via the NUL-parity heuristic (`detectBomlessUtf16`) —
 *    checked BEFORE strict UTF-8, not after it fails, because a densely-ASCII UTF-16 stream
 *    decodes as "valid" UTF-8 without ever throwing (every `(charByte, 0x00)` pair is individually
 *    legal UTF-8), which is exactly the NUL-interleaved mojibake this heuristic exists to prevent.
 * 4. Not BOM-less UTF-16: try strict UTF-8, accepted only when every byte belongs to a
 *    well-formed sequence AND the result carries no unexpected control character
 *    (`hasUnexpectedControlCharacters`) — the signature of a UTF-16 stream too sparse in 0x00
 *    halves for step 3 to catch, but still not real UTF-8 prose.
 * 5. Neither: assume windows-1252, the single-byte fallback every legacy Western European export
 *    this project ingests actually uses.
 *
 * Every step fails OPEN into a broader decode and no input is ever refused: this is a fidelity
 * measurement, and a measurement must not block the ingestion it measures. `encodingFidelityReasons`
 * carries the resulting uncertainty to the operator instead.
 *
 * It stays a heuristic ladder, not a certified sniffer — a UTF-16 file dense enough in non-ASCII
 * text to carry neither a strong NUL-parity signal nor a stray control character (dense CJK, most
 * plausibly) can still fall through to windows-1252, and a windows-1252 file that happens to form
 * valid, control-character-free UTF-8 byte sequences (rare, but possible for short buffers) decodes
 * as UTF-8 instead. Both are the same trade a browser's own encoding sniffer makes; refusing every
 * borderline upload outright would reject more real documents than it protects.
 */
export function decodeTextBuffer(content: Buffer): DecodedText {
  // A loop rather than a recursive call on the remainder: `subarray` is a view, so this is O(1) per
  // BOM, and a buffer of nothing but repeated BOMs — three bytes per frame — would otherwise
  // exhaust the call stack on an upload small enough to pass every size budget.
  let body = content;
  while (startsWith(body, UTF8_BOM)) {
    body = body.subarray(UTF8_BOM.length);
  }

  if (startsWith(body, UTF16LE_BOM)) {
    return decodeDeclaredUtf16(body.subarray(UTF16LE_BOM.length), 'utf-16le');
  }
  if (startsWith(body, UTF16BE_BOM)) {
    return decodeDeclaredUtf16(body.subarray(UTF16BE_BOM.length), 'utf-16be');
  }

  // Checked BEFORE strict UTF-8, not after it fails: every byte of a densely-ASCII UTF-16 stream
  // (charByte, 0x00) is individually a legal single-byte UTF-8 code point — 0x00 included — so
  // `tryDecodeStrictUtf8` never throws on one. It would happily "succeed" and hand back the exact
  // NUL-interleaved mojibake this heuristic exists to prevent. A NUL-parity match this strong is
  // never real UTF-8 prose, so it preempts a merely-valid UTF-8 decode rather than waiting for one
  // to fail first.
  const bomlessUtf16 = detectBomlessUtf16(body);
  if (bomlessUtf16) {
    const bytes = bomlessUtf16 === 'utf-16be' ? swapBytePairs(body) : body;
    return { text: decodeUtf16le(bytes), encoding: bomlessUtf16 };
  }

  const strictUtf8 = tryDecodeStrictUtf8(body);
  if (strictUtf8 !== undefined && !hasUnexpectedControlCharacters(strictUtf8)) {
    return { text: strictUtf8, encoding: 'utf-8' };
  }

  return { text: decodeWindows1252(body), encoding: 'windows-1252' };
}

/**
 * The `reducedFidelityReasons` a parser records for a decode, shared by every parser that reads
 * text through `decodeTextBuffer` so one decode produces one operator-visible signal.
 *
 * `utf-8` alone is confirmed: it is reported only when a strict decode accepted every byte, whether
 * or not a BOM declared it. Every other result is either inferred from content (windows-1252,
 * BOM-less UTF-16) or declared by a UTF-16 BOM that no validity test can confirm, so it is flagged
 * — the flag says "these characters were not verified against the bytes", not "this file is broken".
 */
export function encodingFidelityReasons(encoding: TextEncoding): string[] | undefined {
  return encoding === 'utf-8'
    ? undefined
    : [
        `Source decoded as ${encoding}; unlike utf-8, this encoding cannot be confirmed from the bytes, so some characters may differ from the source`,
      ];
}
