import type { TextEncoding } from '../../../../src/features/evidence/ingestion/decode-text-buffer';
import {
  decodeTextBuffer,
  encodingFidelityReasons,
} from '../../../../src/features/evidence/ingestion/decode-text-buffer';

// Code point -> byte for the 0x80-0x9F span where windows-1252 diverges from Latin-1, transcribed
// from the WHATWG `index-windows-1252` table in the encode direction. Independent of the decoder's
// own table on purpose: re-encoding a decoded string and comparing bytes is then a differential
// check that no character was invented, dropped, or replaced, not a restatement of the decoder.
const WINDOWS_1252_ENCODE_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

function encodeWindows1252(text: string): Buffer {
  return Buffer.from(
    [...text].map((char) => {
      const code = char.codePointAt(0) ?? 0;
      const byte = WINDOWS_1252_ENCODE_HIGH[code] ?? code;
      if (byte > 0xff) {
        throw new Error(`U+${code.toString(16)} has no windows-1252 byte`);
      }
      return byte;
    }),
  );
}

function toBigEndian(littleEndian: Buffer): Buffer {
  const big = Buffer.alloc(littleEndian.length - (littleEndian.length % 2));
  for (let i = 0; i < big.length; i += 2) {
    big[i] = littleEndian[i + 1];
    big[i + 1] = littleEndian[i];
  }
  return big;
}

/** Re-encodes decoded text under the encoding the decoder reports it used, so the sweep can compare
 * against the source bytes rather than against a second decoder that could share a bug. */
function reEncode(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf8');
    case 'utf-16le':
      return Buffer.from(text, 'utf16le');
    case 'utf-16be':
      return toBigEndian(Buffer.from(text, 'utf16le'));
    case 'windows-1252':
      return encodeWindows1252(text);
  }
}

/** The bytes a lossless decode can account for: a UTF-16 decode consumes whole code units, so a
 * trailing odd byte is dropped by design (see `swapBytePairs`) and is not part of the round-trip. */
function accountableBytes(body: Buffer, encoding: TextEncoding): Buffer {
  return encoding === 'utf-16le' || encoding === 'utf-16be'
    ? body.subarray(0, body.length - (body.length % 2))
    : body;
}

describe('decodeTextBuffer', () => {
  describe('BOM detection', () => {
    it('should strip a UTF-8 BOM and decode the remainder as UTF-8', () => {
      const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Rent Roll')]);

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'Rent Roll', encoding: 'utf-8' });
    });

    it('should decode a UTF-16LE buffer carrying its BOM', () => {
      const content = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('Rent Roll', 'utf16le'),
      ]);

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'Rent Roll', encoding: 'utf-16le' });
    });

    it('should byte-swap and decode a UTF-16BE buffer carrying its BOM', () => {
      const little = Buffer.from('Rent Roll', 'utf16le');
      const big = Buffer.alloc(little.length);
      for (let i = 0; i < little.length; i += 2) {
        big[i] = little[i + 1];
        big[i + 1] = little[i];
      }
      const content = Buffer.concat([Buffer.from([0xfe, 0xff]), big]);

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'Rent Roll', encoding: 'utf-16be' });
    });

    it('should drop a trailing odd byte when byte-swapping a malformed UTF-16BE buffer rather than pairing it with a phantom zero', () => {
      const content = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x41, 0x00])]);

      const result = decodeTextBuffer(content);

      expect(result.text).toBe('A');
      expect(result.encoding).toBe('utf-16be');
    });

    it('should decode a well-formed UTF-16LE buffer to text that survives a UTF-8 round-trip', () => {
      const content = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('Rent Roll', 'utf16le'),
      ]);

      const result = decodeTextBuffer(content);

      expect(result.text.isWellFormed()).toBe(true);
      expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
    });

    it("should drop a truncated UTF-16LE buffer's lone trailing surrogate rather than emit an ill-formed string", () => {
      // "A" (0x0041 LE) followed by the high half of a surrogate pair (0xD83D LE) with no low
      // half to complete it — exactly what a stream cut off mid-character produces.
      const content = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from([0x41, 0x00, 0x3d, 0xd8]),
      ]);

      const result = decodeTextBuffer(content);

      expect(result.text.isWellFormed()).toBe(true);
      expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
    });
  });

  describe('strict UTF-8 (no BOM)', () => {
    it('should decode ordinary ASCII as UTF-8', () => {
      const content = Buffer.from('Northgate Business Park', 'utf-8');

      expect(decodeTextBuffer(content)).toEqual({
        text: 'Northgate Business Park',
        encoding: 'utf-8',
      });
    });

    it('should decode a valid multi-byte UTF-8 sequence rather than falling through to windows-1252', () => {
      const content = Buffer.from('café', 'utf-8');

      expect(decodeTextBuffer(content)).toEqual({ text: 'café', encoding: 'utf-8' });
    });

    it('should decode an empty buffer as an empty UTF-8 string', () => {
      expect(decodeTextBuffer(Buffer.alloc(0))).toEqual({ text: '', encoding: 'utf-8' });
    });
  });

  describe('BOM-less UTF-16 (NUL-parity heuristic)', () => {
    it('should detect and decode a BOM-less UTF-16LE buffer', () => {
      const content = Buffer.from('Rent Roll figures for Q3 2025', 'utf16le');

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'Rent Roll figures for Q3 2025', encoding: 'utf-16le' });
    });

    it('should detect and decode a BOM-less UTF-16BE buffer', () => {
      const little = Buffer.from('Rent Roll figures for Q3 2025', 'utf16le');
      const big = Buffer.alloc(little.length);
      for (let i = 0; i < little.length; i += 2) {
        big[i] = little[i + 1];
        big[i + 1] = little[i];
      }

      const result = decodeTextBuffer(big);

      expect(result).toEqual({ text: 'Rent Roll figures for Q3 2025', encoding: 'utf-16be' });
    });

    it('should prefer the UTF-16 heuristic over a "successful" strict UTF-8 decode — the mojibake this parser exists to prevent', () => {
      // Every (charByte, 0x00) pair is individually legal UTF-8, so a naive strict-UTF-8-first
      // decoder would "succeed" here and hand back text with a NUL wedged after every character.
      const content = Buffer.from('Excel export', 'utf16le');

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'Excel export', encoding: 'utf-16le' });
      // A naive strict-UTF-8-first decode does not throw on these bytes at all — it "succeeds"
      // with this NUL-interleaved mojibake instead. Asserting against it pins the ordering fix.
      expect(new TextDecoder('utf-8', { fatal: true }).decode(content)).toContain(
        String.fromCharCode(0),
      );
    });

    it('should fall through to windows-1252 for a short buffer with no NUL bytes at all', () => {
      const content = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "caf" + a lone 0xE9

      const result = decodeTextBuffer(content);

      expect(result.encoding).toBe('windows-1252');
    });
  });

  describe('windows-1252 fallback', () => {
    it('should map a byte in the 0x80-0x9F range through the cp1252 table', () => {
      // "Tenant’s" with the windows-1252 right-single-quote byte (0x92).
      const content = Buffer.from([0x54, 0x65, 0x6e, 0x61, 0x6e, 0x74, 0x92, 0x73]);

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'Tenant’s', encoding: 'windows-1252' });
    });

    it('should treat a byte at or above 0xA0 as its Latin-1-equivalent code point', () => {
      const content = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café"

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'café', encoding: 'windows-1252' });
    });

    it('should decode an unassigned cp1252 byte (0x81) to its own C1-control code point rather than throwing or dropping it', () => {
      const content = Buffer.from([0x61, 0x81, 0x62]);

      const result = decodeTextBuffer(content);

      expect(result.encoding).toBe('windows-1252');
      expect(result.text).toBe('a\x81b');
    });
  });

  describe('unexpected control characters (the DEL/C1 guard, and its length threshold)', () => {
    // Every code point below decodes as strict UTF-8 on its own — U+007F is a single UTF-8 byte,
    // U+0080 and U+009F each need a valid two-byte sequence (0xC2 0x80-0x9F) — so only the
    // DEL/C1 disjunct in `hasUnexpectedControlCharacters` decides whether the buffer is accepted
    // as confirmed utf-8 or falls through to windows-1252.
    const CONTROL_CODE_POINTS: readonly { readonly codePoint: number; readonly label: string }[] = [
      { codePoint: 0x7f, label: 'U+007F (DEL)' },
      { codePoint: 0x80, label: 'U+0080 (start of the C1 block)' },
      { codePoint: 0x9f, label: 'U+009F (end of the C1 block)' },
    ];

    CONTROL_CODE_POINTS.forEach(({ codePoint, label }) => {
      it(`should reject a strict-UTF-8 buffer containing ${label} as confirmed utf-8, falling through to windows-1252`, () => {
        const text = 'Q'.repeat(15) + String.fromCodePoint(codePoint) + 'RRRR';
        const content = Buffer.from(text, 'utf-8');

        const result = decodeTextBuffer(content);

        expect(result.encoding).toBe('windows-1252');
      });
    });

    it('should still confirm a strict-UTF-8 buffer of the same length carrying no control character as utf-8', () => {
      const text = 'Q'.repeat(15) + 'SRRRR';
      const content = Buffer.from(text, 'utf-8');

      expect(decodeTextBuffer(content)).toEqual({ text, encoding: 'utf-8' });
    });

    it('should not flag one control character below the length threshold, confirming utf-8', () => {
      const text = 'Q'.repeat(14) + '\x01';

      expect(decodeTextBuffer(Buffer.from(text, 'utf-8'))).toEqual({ text, encoding: 'utf-8' });
    });

    it('should flag the same control character one position later, at the length threshold, falling through to windows-1252', () => {
      const text = 'Q'.repeat(15) + '\x01';

      expect(decodeTextBuffer(Buffer.from(text, 'utf-8')).encoding).toBe('windows-1252');
    });
  });

  describe('declaration versus content (every BOM this decoder recognises, against every content kind)', () => {
    // One readable string carrying the characters an operator reads figures through — an em-dash,
    // smart quotes and an accented letter — so a wrong decode shows up as changed text rather than
    // as a difference no reader would notice.
    const READABLE = 'Revenue rose 12% — “Bâle” unit';
    const ASCII = 'Rent Rolls';
    // Dense non-ASCII UTF-16: 58 bytes carrying a single NUL half, so the NUL-parity heuristic
    // cannot see it and a strict UTF-8 decode accepts its code units taken singly. It is what a
    // UTF-16 declaration must keep protecting — the unmarked ladder resolves these bytes to
    // windows-1252 mojibake, so overriding the BOM on anything short of a parity contradiction
    // would corrupt a genuine document to repair a mislabelled one.
    const DENSE = '第三季度租金收入为一千二百万元，较上年同期增长百分之十二。';

    const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
    const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

    const utf8Body = Buffer.from(READABLE, 'utf8');
    const cp1252Body = encodeWindows1252(READABLE);
    const utf16leBody = Buffer.from(READABLE, 'utf16le');
    const utf16beBody = toBigEndian(utf16leBody);
    const asciiBody = Buffer.from(ASCII, 'latin1');
    const denseUtf16leBody = Buffer.from(DENSE, 'utf16le');
    const denseUtf16beBody = toBigEndian(denseUtf16leBody);
    // `0xC3` opens a two-byte UTF-8 sequence that `0x28` cannot continue, and there is no NUL
    // parity to read as UTF-16 — valid in neither, so windows-1252 is the only encoding left.
    const neitherBody = Buffer.from([0x41, 0xc3, 0x28, 0x42]);
    const emptyBody = Buffer.alloc(0);

    interface DeclarationCell {
      /** The BOM the source uses to declare its encoding. */
      readonly declaration: string;
      readonly bom: Buffer;
      /** What the bytes after the BOM genuinely are, regardless of the declaration. */
      readonly content: string;
      readonly body: Buffer;
      /** The encoding the decoder must report — the one it actually decoded with. */
      readonly encoding: TextEncoding;
      /** The text a reader of `encoding` sees. Omitted where the content is undecidable: a
       * UTF-16 declaration over single-byte content cannot be refuted, because dense non-ASCII
       * UTF-16 (CJK sits at `U+4E00`-`U+7FFF`, whose code units carry no NUL half and form valid
       * UTF-8 byte pairs) is indistinguishable from it. Those cells assert the round-trip only. */
      readonly text?: string;
    }

    const cells: readonly DeclarationCell[] = [
      // A UTF-8 BOM declares an encoding a strict decode can confirm, so every cell here is
      // decidable: the content wins wherever it contradicts the declaration.
      {
        declaration: 'UTF-8 BOM',
        bom: UTF8_BOM,
        content: 'UTF-8 content',
        body: utf8Body,
        encoding: 'utf-8',
        text: READABLE,
      },
      {
        declaration: 'UTF-8 BOM',
        bom: UTF8_BOM,
        content: 'windows-1252 content',
        body: cp1252Body,
        encoding: 'windows-1252',
        text: READABLE,
      },
      {
        declaration: 'UTF-8 BOM',
        bom: UTF8_BOM,
        content: 'UTF-16LE content',
        body: utf16leBody,
        encoding: 'utf-16le',
        text: READABLE,
      },
      {
        declaration: 'UTF-8 BOM',
        bom: UTF8_BOM,
        content: 'UTF-16BE content',
        body: utf16beBody,
        encoding: 'utf-16be',
        text: READABLE,
      },
      {
        declaration: 'UTF-8 BOM',
        bom: UTF8_BOM,
        content: 'ASCII content',
        body: asciiBody,
        encoding: 'utf-8',
        text: ASCII,
      },
      {
        declaration: 'UTF-8 BOM',
        bom: UTF8_BOM,
        content: 'content valid in no encoding it could declare',
        body: neitherBody,
        encoding: 'windows-1252',
        text: 'AÃ(B',
      },
      {
        declaration: 'UTF-8 BOM',
        bom: UTF8_BOM,
        content: 'no content',
        body: emptyBody,
        encoding: 'utf-8',
        text: '',
      },

      // A UTF-16 declaration is confirmable only against the opposite endianness: the NUL parity of
      // the content refutes it outright. Nothing else refutes it, so it stands.
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'UTF-16LE content',
        body: utf16leBody,
        encoding: 'utf-16le',
        text: READABLE,
      },
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'UTF-16BE content',
        body: utf16beBody,
        encoding: 'utf-16be',
        text: READABLE,
      },
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'dense non-ASCII UTF-16LE content',
        body: denseUtf16leBody,
        encoding: 'utf-16le',
        text: DENSE,
      },
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'UTF-8 content',
        body: utf8Body,
        encoding: 'utf-16le',
      },
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'windows-1252 content',
        body: cp1252Body,
        encoding: 'utf-16le',
      },
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'ASCII content',
        body: asciiBody,
        encoding: 'utf-16le',
      },
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'content valid in no encoding it could declare',
        body: neitherBody,
        encoding: 'utf-16le',
      },
      {
        declaration: 'UTF-16LE BOM',
        bom: UTF16LE_BOM,
        content: 'no content',
        body: emptyBody,
        encoding: 'utf-16le',
        text: '',
      },

      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'UTF-16BE content',
        body: utf16beBody,
        encoding: 'utf-16be',
        text: READABLE,
      },
      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'UTF-16LE content',
        body: utf16leBody,
        encoding: 'utf-16le',
        text: READABLE,
      },
      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'dense non-ASCII UTF-16BE content',
        body: denseUtf16beBody,
        encoding: 'utf-16be',
        text: DENSE,
      },
      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'UTF-8 content',
        body: utf8Body,
        encoding: 'utf-16be',
      },
      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'windows-1252 content',
        body: cp1252Body,
        encoding: 'utf-16be',
      },
      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'ASCII content',
        body: asciiBody,
        encoding: 'utf-16be',
      },
      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'content valid in no encoding it could declare',
        body: neitherBody,
        encoding: 'utf-16be',
      },
      {
        declaration: 'UTF-16BE BOM',
        bom: UTF16BE_BOM,
        content: 'no content',
        body: emptyBody,
        encoding: 'utf-16be',
        text: '',
      },
    ];

    cells.forEach((cell) => {
      it(`should decode a ${cell.declaration} declaring ${cell.content} as ${cell.encoding}, and report that encoding`, () => {
        const result = decodeTextBuffer(Buffer.concat([cell.bom, cell.body]));

        // The reported encoding is the one the text was produced with, not the one declared —
        // every consumer keys its fidelity signal on it.
        expect(result.encoding).toBe(cell.encoding);
        // Storage hashes and re-reads the text as UTF-8; a lone surrogate would desync both.
        expect(result.text.isWellFormed()).toBe(true);
        // Round-tripping under the reported encoding reproduces the source bytes exactly: nothing
        // was replaced with U+FFFD, dropped, or invented.
        expect(reEncode(result.text, result.encoding)).toEqual(
          accountableBytes(cell.body, cell.encoding),
        );
        if (cell.text !== undefined) {
          expect(result.text).toBe(cell.text);
        }
      });
    });

    it('should decode a UTF-8 BOM-prefixed buffer exactly as it decodes the same bytes unmarked', () => {
      const bodies = [utf8Body, cp1252Body, utf16leBody, utf16beBody, asciiBody, neitherBody];

      bodies.forEach((body) => {
        expect(decodeTextBuffer(Buffer.concat([UTF8_BOM, body]))).toEqual(decodeTextBuffer(body));
      });
    });

    it('should strip an unbounded run of UTF-8 BOMs without exhausting the stack', () => {
      // 100k BOMs is a 300KB upload — well inside every size budget on the ingestion path, and the
      // shape that turns per-BOM recursion into a RangeError instead of a decode.
      const content = Buffer.concat(Array.from({ length: 100_000 }, () => UTF8_BOM));

      expect(decodeTextBuffer(content)).toEqual({ text: '', encoding: 'utf-8' });
      expect(decodeTextBuffer(Buffer.concat([content, cp1252Body]))).toEqual({
        text: READABLE,
        encoding: 'windows-1252',
      });
    });

    it('should keep a UTF-16 declaration the unmarked ladder cannot reproduce, absent a parity contradiction', () => {
      // The counterfactual behind `decodeDeclaredUtf16`: one NUL half in 58 bytes is far below the
      // parity threshold and every code unit is legal UTF-8 taken singly, so without the BOM this
      // text is unrecoverable. A UTF-16 BOM therefore yields only to the opposite endianness —
      // never to "this could be single-byte content", which would destroy the document below.
      const unmarked = decodeTextBuffer(denseUtf16leBody);

      expect(unmarked.encoding).toBe('windows-1252');
      expect(unmarked.text).not.toBe(DENSE);
    });
  });

  describe('content code-point composition (generated across scripts and ASCII density)', () => {
    // A small deterministic PRNG so the sweep is reproducible without a dependency: a fixed seed
    // means a failure always reproduces from the same generated fixture.
    function mulberry32(seed: number): () => number {
      let state = seed;
      return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // One code point range per script, chosen to avoid surrogates, combining marks and the BOM
    // character itself, so every generated code point is exactly one UTF-16 code unit.
    const UNICODE_BLOCKS: Readonly<Record<string, readonly [number, number]>> = {
      'Latin-1 Supplement': [0x00a0, 0x00ff],
      'Latin Extended-A': [0x0100, 0x017f],
      Greek: [0x0391, 0x03a9],
      Cyrillic: [0x0410, 0x044f],
      Hebrew: [0x05d0, 0x05ea],
      Devanagari: [0x0900, 0x097f],
      Thai: [0x0e01, 0x0e3a],
      Hiragana: [0x3041, 0x3096],
      'CJK Unified Ideographs': [0x4e00, 0x62ff],
      'Hangul Syllables': [0xac00, 0xd7a3],
    };

    // The word-separators and punctuation a real document in any of these scripts actually
    // contains, mixed in at `asciiFraction` — not just the block's own code points.
    const ASCII_SEPARATORS = ' .,;:!?-';

    function generateDocument(
      rng: () => number,
      block: readonly [number, number],
      length: number,
      asciiFraction: number,
    ): string {
      const [lo, hi] = block;
      const chars: string[] = [];
      for (let i = 0; i < length; i += 1) {
        if (rng() < asciiFraction) {
          chars.push(ASCII_SEPARATORS[Math.floor(rng() * ASCII_SEPARATORS.length)]);
        } else {
          chars.push(String.fromCodePoint(lo + Math.floor(rng() * (hi - lo + 1))));
        }
      }
      return chars.join('');
    }

    const rng = mulberry32(20260827);

    Object.entries(UNICODE_BLOCKS).forEach(([blockName, range]) => {
      [0, 0.1, 0.2, 0.3, 0.4, 0.5].forEach((asciiFraction) => {
        it(`should faithfully decode or flag a BOM-less UTF-16LE ${blockName} document at ${asciiFraction * 100}% ASCII/punctuation density`, () => {
          const text = generateDocument(rng, range, 200, asciiFraction);
          const body = Buffer.from(text, 'utf16le');

          const result = decodeTextBuffer(body);

          // The invariant this module exists to uphold: the text handed back is a faithful
          // decoding of the source, or the caller is told fidelity is uncertain. Never neither —
          // that is silent corruption presented as verified.
          expect(
            result.text === text || encodingFidelityReasons(result.encoding) !== undefined,
          ).toBe(true);
        });
      });
    });

    it('should never report a BOM-less UTF-16 document containing ordinary ASCII word-separators as confirmed utf-8', () => {
      // The failure this sweep exists to catch: a script whose code units carry too few NUL halves
      // for the parity heuristic, but whose bytes still happen to validate as strict UTF-8, landing
      // on the one branch `encodingFidelityReasons` never flags.
      const blocks = Object.values(UNICODE_BLOCKS);
      blocks.forEach((range) => {
        [0.1, 0.2, 0.3].forEach((asciiFraction) => {
          const text = generateDocument(rng, range, 300, asciiFraction);
          const body = Buffer.from(text, 'utf16le');

          const result = decodeTextBuffer(body);

          if (result.encoding === 'utf-8') {
            expect(result.text).toBe(text);
          }
        });
      });
    });
  });

  describe('buffer length (exhaustive short-buffer enumeration)', () => {
    // Every byte string of length 0-8 over a 3-symbol alphabet: an ASCII letter, a literal NUL,
    // and a high byte that is neither a valid UTF-8 lead nor continuation on its own — 9,841
    // buffers, exhaustive rather than sampled, covering the length axis around the `length < 4`
    // cutoff and the small-`pairCount` ratio quantization in `detectBomlessUtf16`.
    const ALPHABET = [0x41, 0x00, 0xe9];

    function* enumerateByteStrings(maxLength: number): Generator<number[]> {
      for (let length = 0; length <= maxLength; length += 1) {
        const combinations = ALPHABET.length ** length;
        for (let n = 0; n < combinations; n += 1) {
          const bytes: number[] = [];
          let remainder = n;
          for (let position = 0; position < length; position += 1) {
            bytes.push(ALPHABET[remainder % ALPHABET.length]);
            remainder = Math.floor(remainder / ALPHABET.length);
          }
          yield bytes;
        }
      }
    }

    // A ground-truth oracle for the BOM-less NUL-parity heuristic, written independently of
    // `detectBomlessUtf16` from the buffer bytes alone — none of `ALPHABET` can form a BOM, so
    // every buffer in this sweep reaches that heuristic and nothing else decides its classification.
    // A "faithful or flagged" check alone cannot tell a correct UTF-16 classification from a wrong
    // one: decode-then-re-encode is an involution, so a misclassified buffer still round-trips
    // under the (wrong) encoding it was misclassified as. Only a classification computed from the
    // source bytes, not from the module's own answer, can catch that.
    function expectedBomlessUtf16(buffer: Buffer): 'utf-16le' | 'utf-16be' | undefined {
      if (buffer.length < 4) {
        return undefined;
      }
      const pairCount = Math.floor(buffer.length / 2);
      let evenZero = 0;
      let oddZero = 0;
      for (let i = 0; i < pairCount; i += 1) {
        if (buffer[i * 2] === 0x00) evenZero += 1;
        if (buffer[i * 2 + 1] === 0x00) oddZero += 1;
      }
      const evenRatio = evenZero / pairCount;
      const oddRatio = oddZero / pairCount;
      // Below 16 pairs, parity must be unanimous; at or above it, 0.4 is enough.
      const required = pairCount < 16 ? 1 : 0.4;
      if (oddRatio >= required && oddRatio > evenRatio) {
        return 'utf-16le';
      }
      if (evenRatio >= required && evenRatio > oddRatio) {
        return 'utf-16be';
      }
      return undefined;
    }

    /** Asserts the module's result against ground truth computed from `buffer` itself: any
     * BOM-less UTF-16 classification, in either direction, must match `expectedBomlessUtf16`
     * exactly, and every decode must faithfully round-trip under whatever encoding was reported. */
    function assertGroundTruth(buffer: Buffer, result: ReturnType<typeof decodeTextBuffer>): void {
      const expectedBomless = expectedBomlessUtf16(buffer);
      if (result.encoding === 'utf-16le' || result.encoding === 'utf-16be' || expectedBomless) {
        expect(result.encoding).toBe(expectedBomless);
      }

      const faithful = reEncode(result.text, result.encoding).equals(
        accountableBytes(buffer, result.encoding),
      );
      expect(faithful).toBe(true);
    }

    it('should decode every byte string of length 0-8 over {ASCII, NUL, high-byte} to the encoding the NUL-parity heuristic itself justifies, faithfully', () => {
      let checked = 0;
      for (const bytes of enumerateByteStrings(8)) {
        const buffer = Buffer.from(bytes);
        const result = decodeTextBuffer(buffer);

        assertGroundTruth(buffer, result);
        checked += 1;
      }
      expect(checked).toBe(9_841);
    });

    it('should extend the exhaustive sweep to length 9-16 by random sampling the same alphabet', () => {
      let state = 424242;
      const next = (): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state;
      };

      for (let trial = 0; trial < 500; trial += 1) {
        const length = 9 + (next() % 8);
        const bytes = Array.from({ length }, () => ALPHABET[next() % ALPHABET.length]);
        const buffer = Buffer.from(bytes);
        const result = decodeTextBuffer(buffer);

        assertGroundTruth(buffer, result);
      }
    });

    it('should decode 4 bytes of valid UTF-8 containing one NUL as confirmed utf-8, not invented CJK', () => {
      // The defect this pins as a regression: a single NUL byte among 2 pairs used to clear the
      // 0.4 NUL-parity ratio outright (1/2 = 0.5), reporting these 4 bytes of ordinary ASCII text
      // as utf-16le and inventing a CJK character that was never in the source.
      const content = Buffer.from([0x41, 0x00, 0x42, 0x43]); // "A\0BC"

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'A\0BC', encoding: 'utf-8' });
    });

    it('should decode 4 bytes of valid UTF-8 with a differently-placed NUL as confirmed utf-8 too', () => {
      const content = Buffer.from([0x41, 0x42, 0x00, 0x43]); // "AB\0C"

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: 'AB\0C', encoding: 'utf-8' });
    });
  });

  describe('NUL-half parity direction versus a correct UTF-16 declaration', () => {
    // U+4E00 ('一', the most common CJK ideograph) and U+AC00 (the first Hangul syllable) both put
    // a real, legitimate NUL half on the byte parity opposite an ASCII character's — code points of
    // the form U+XX00 — with no endianness disagreement at all. U+4E2D ('中') carries no NUL half
    // on either parity and is the filler between them.
    const ZERO_LOW_CHAR = '\u{4E00}';
    const FILLER_CHAR = '\u{4E2D}';

    function buildBody(fraction: number, totalChars: number): string {
      const zeroLowCount = Math.round(totalChars * fraction);
      return ZERO_LOW_CHAR.repeat(zeroLowCount) + FILLER_CHAR.repeat(totalChars - zeroLowCount);
    }

    // 0-0.8 is the realistic range for prose that happens to be rich in U+XX00 code points; 0.9
    // and 1.0 are the adversarial extreme (every code point sharing the same specific low byte),
    // included to pin that even there the result stays flagged rather than silently wrong.
    const FRACTIONS = [0, 0.1, 0.2, 0.3, 0.39, 0.4, 0.5, 0.6, 0.75, 0.8, 0.9, 1.0];

    (['utf-16le', 'utf-16be'] as const).forEach((declared) => {
      const bom = declared === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);

      FRACTIONS.forEach((fraction) => {
        it(`should decode a correct ${declared} BOM over a body ${fraction * 100}% U+XX00 code points as faithful or flagged, never neither`, () => {
          const text = buildBody(fraction, 40);
          const leBody = Buffer.from(text, 'utf16le');
          const body = declared === 'utf-16be' ? toBigEndian(leBody) : leBody;

          const result = decodeTextBuffer(Buffer.concat([bom, body]));

          const flagged = encodingFidelityReasons(result.encoding) !== undefined;
          expect(result.text === text || flagged).toBe(true);
          // Every UTF-16 result is flagged unconditionally, so this axis can never produce the
          // unflagged corruption the invariant forbids — but a correct declaration should still
          // survive realistic density without being overridden at all.
          if (fraction <= 0.8) {
            expect(result.encoding).toBe(declared);
            expect(result.text).toBe(text);
          }
        });
      });
    });
  });

  describe('BOM byte sequences occurring as ordinary body content', () => {
    const TAIL = 'Rent Roll figures for Q3 2025';

    it('should decode BOM-less UTF-16LE content whose leading code units render as a UTF-8 BOM as faithful or flagged', () => {
      // U+BBEF U+00BF encodes, in LE, to the exact bytes `EF BB BF 00` — indistinguishable at the
      // byte level from a genuine UTF-8 BOM followed by a NUL.
      const text = '\u{BBEF}\u{00BF}' + TAIL;
      const body = Buffer.from(text, 'utf16le');

      const result = decodeTextBuffer(body);

      const flagged = encodingFidelityReasons(result.encoding) !== undefined;
      expect(result.text === text || flagged).toBe(true);
    });

    it('should decode BOM-less UTF-16BE content whose leading code units render as a UTF-8 BOM as faithful or flagged', () => {
      const text = '\u{EFBB}\u{BF00}' + TAIL;
      const body = toBigEndian(Buffer.from(text, 'utf16le'));

      const result = decodeTextBuffer(body);

      const flagged = encodingFidelityReasons(result.encoding) !== undefined;
      expect(result.text === text || flagged).toBe(true);
    });

    it('KNOWN LIMITATION: strips a windows-1252 document whose first three bytes coincide with the UTF-8 BOM as if they were one, losing those characters unflagged', () => {
      // `EF BB BF` is simultaneously the UTF-8 BOM and a valid (if unusual) windows-1252 sequence
      // ('ï»¿'). The strip loop in `decodeTextBuffer` cannot tell these apart — it runs before any
      // encoding is inferred — so this is genuine unflagged corruption, not merely a documented
      // heuristic trade-off: unlike every UTF-16-flavoured collision on this axis, the tail here is
      // plain ASCII, so the buffer re-validates as strict UTF-8 after the strip and is never
      // flagged. Resolving it needs a signal this module does not have (an external encoding hint,
      // or a content-plausibility model) rather than a threshold adjustment, so this test pins the
      // current, imperfect behaviour as a regression rather than asserting the invariant.
      const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TAIL, 'latin1')]);

      const result = decodeTextBuffer(content);

      expect(result).toEqual({ text: TAIL, encoding: 'utf-8' });
    });
  });
});
