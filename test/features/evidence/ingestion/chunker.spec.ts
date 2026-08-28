import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type {
  DocxParagraphLocator,
  PdfPageLocator,
  XlsxRegionLocator,
} from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  chunkElements,
  resolveCitationLocator,
} from '../../../../src/features/evidence/ingestion/chunker';
import { CsvParser } from '../../../../src/features/evidence/ingestion/parsers/csv.parser';
import { DocxParser } from '../../../../src/features/evidence/ingestion/parsers/docx.parser';
import type { ParsedElement } from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { XlsxParser } from '../../../../src/features/evidence/ingestion/parsers/xlsx.parser';
import { locateQuote } from '../../../../src/shared/utils/locate-quote.util';
import manifest from '../../../../fixtures/data-room/manifest.json';

const DOCX_FIXTURE_PATH = path.join(__dirname, '../../../../fixtures/data-room/lease-summary.docx');
const XLSX_FIXTURE_PATH = path.join(__dirname, '../../../../fixtures/data-room/comps.xlsx');

function pdfElement(
  page: number,
  text: string,
  overrides: Partial<ParsedElement> = {},
): ParsedElement {
  const locator: PdfPageLocator = {
    kind: 'pdf-page',
    page,
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    extractorVersion: 'pdf-pdfjs-1',
  };
  return { text, locator, headingPath: [], ...overrides };
}

function docxElement(
  paragraphIndex: number,
  text: string,
  headingPath: readonly string[],
): ParsedElement {
  const locator: DocxParagraphLocator = {
    kind: 'docx-paragraph',
    paragraphIndex,
    headingPath: [...headingPath],
    extractorVersion: 'docx-ooxml-1',
  };
  return { text, locator, headingPath };
}

function xlsxCellElement(sheetName: string, cell: string, text: string): ParsedElement {
  return {
    text,
    locator: { kind: 'xlsx-cell', sheetName, cell, extractorVersion: 'xlsx-exceljs-2' },
    headingPath: [],
  };
}

/** One `xlsx-cell` element per cell of `rows`, addressed A1-style from the grid position, so a test
 * can state a sheet as the table it is rather than as a list of addresses. */
function sheetGrid(rows: readonly (readonly string[])[]): ParsedElement[] {
  return rows.flatMap((cells, rowIndex) =>
    cells.map((text, columnIndex) =>
      xlsxCellElement('Sheet1', `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`, text),
    ),
  );
}

// Built from code points rather than typed as source escapes: each renders as an invisible
// character a reviewer reading this file cannot tell apart from the next.
const VERTICAL_TAB = String.fromCharCode(0x0b);
const FORM_FEED = String.fromCharCode(0x0c);
const NEXT_LINE = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Every code point a reader of the chunker's pipe-table grammar takes as the end of a row: the two
 * ASCII line breaks and the CRLF pair, plus the further terminators JavaScript's own regex engine
 * and a markdown renderer accept as line breaks. The reader below counts rows with it, so a cell
 * that smuggles any of them reads as an extra row rather than passing unnoticed.
 */
const ROW_BREAK_PATTERN = new RegExp(
  `\\r\\n|[\\n\\r${VERTICAL_TAB}${FORM_FEED}${NEXT_LINE}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`,
);

/** A cell a reader takes as part of a header-separator row (GFM's optional alignment colons around
 * a dash run). Tested against the raw serialized segment, never the decoded text: an escaped dash
 * is literal content to a reader, not separator structure. */
const SEPARATOR_CELL_PATTERN = /^\s*:?-+:?\s*$/;

/** The character each single-letter escape stands for, read back independently of the map the
 * chunker escapes with — a reader decodes the convention, it does not share the table. */
const DECODED_BY_ESCAPE_TOKEN = new Map<string, string>([
  ['\\', '\\'],
  ['|', '|'],
  ['-', '-'],
  ['n', '\n'],
  ['r', '\r'],
  ['v', VERTICAL_TAB],
  ['f', FORM_FEED],
]);

/** Splits one serialized table line on every `|` a reader takes as a cell boundary — every `|` not
 * carried by a backslash escape — returning the segments still escaped. `| a | b |` yields four: an
 * empty leading segment, the two cells, and an empty trailing one. */
function splitRowSegments(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === '\\' && index + 1 < line.length) {
      current += line.slice(index, index + 2);
      index += 2;
    } else if (character === '|') {
      segments.push(current);
      current = '';
      index += 1;
    } else {
      current += character;
      index += 1;
    }
  }
  segments.push(current);
  return segments;
}

/** Decodes one serialized cell back to the text it was built from, throwing on any escape the
 * grammar does not define — a cell a reader cannot decode is a serialization defect, not a pass. */
function decodeCellSegment(segment: string): string {
  let text = '';
  let index = 0;
  while (index < segment.length) {
    if (segment[index] !== '\\') {
      text += segment[index];
      index += 1;
      continue;
    }
    const token = segment[index + 1];
    if (token === 'u') {
      const hex = segment.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/.test(hex)) {
        throw new Error(`Malformed \\u escape in cell segment ${JSON.stringify(segment)}`);
      }
      text += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    const decoded = DECODED_BY_ESCAPE_TOKEN.get(token);
    if (decoded === undefined) {
      throw new Error(`Unknown escape in cell segment ${JSON.stringify(segment)}`);
    }
    text += decoded;
    index += 2;
  }
  return text;
}

/** The decoded cells of one serialized row. Throws when the line is not a single fenced row, or
 * when a cell is not padded by the joins `toMarkdownRow` writes around it. */
function readRowCells(line: string): string[] {
  const segments = splitRowSegments(line);
  const lastIndex = segments.length - 1;
  if (segments.length < 3 || segments[0] !== '' || segments[lastIndex] !== '') {
    throw new Error(`Line ${JSON.stringify(line)} is not a single fenced table row`);
  }
  return segments.slice(1, lastIndex).map((segment) => {
    if (segment.length < 2 || !segment.startsWith(' ') || !segment.endsWith(' ')) {
      throw new Error(`Cell segment ${JSON.stringify(segment)} is not padded by the row's joins`);
    }
    return decodeCellSegment(segment.slice(1, -1));
  });
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRowSegments(line).slice(1, -1);
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL_PATTERN.test(cell));
}

/** The cells of one serialized row exactly as they were written, escapes and all — what a reader
 * sees before decoding anything. Used where the question is whether an escape was introduced at
 * all, which decoding would hide. */
function rawCellSegments(line: string): string[] {
  return splitRowSegments(line)
    .slice(1, -1)
    .map((segment) => segment.slice(1, -1));
}

/**
 * Reads `chunkText` back the way a credulous reader would and reports the first way its shape
 * differs from `expectedRows` (the header row first, the separator row excluded): a row count a
 * cell changed, a column count or a key a cell changed, a second separator row, or a cell that no
 * longer decodes to the text it was built from. Returns `undefined` when the table survives intact.
 *
 * A plain function rather than a chain of `expect`s, so the exhaustive sweeps below can run it a
 * million times and assert once.
 */
function describeTableShapeViolation(
  chunkText: string,
  expectedRows: readonly (readonly string[])[],
): string | undefined {
  try {
    const lines = chunkText.split(ROW_BREAK_PATTERN);
    if (lines.length !== expectedRows.length + 1) {
      return `read ${lines.length} rows, expected ${expectedRows.length + 1} (${expectedRows.length} content rows plus the separator)`;
    }
    const separatorRows = lines.flatMap((line, index) => (isSeparatorRow(line) ? [index] : []));
    if (separatorRows.length !== 1 || separatorRows[0] !== 1) {
      return `expected one separator row at index 1, read separator rows at [${separatorRows.join(', ')}]`;
    }
    const contentLines = lines.filter((_line, index) => index !== 1);
    for (const [rowIndex, line] of contentLines.entries()) {
      const cells = readRowCells(line);
      const expected = expectedRows[rowIndex];
      if (cells.length !== expected.length) {
        return `row ${rowIndex} read ${cells.length} cells, expected ${expected.length}`;
      }
      for (const [columnIndex, cell] of cells.entries()) {
        if (cell !== expected[columnIndex]) {
          return `row ${rowIndex} cell ${columnIndex} read ${JSON.stringify(cell)}, expected ${JSON.stringify(expected[columnIndex])}`;
        }
      }
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'the emitted table could not be read at all';
  }
}

/**
 * The characters that carry structure in the table the chunker emits, derived from that grammar
 * rather than from a list of reported inputs: the cell delimiter, every code point a reader takes
 * as a row break, and the backslash that carries an escape (an escape a cell can forge is no
 * escape). The code-point sweep below is what makes this enumeration falsifiable.
 */
const STRUCTURAL_CHARACTERS = [
  '|',
  '\\',
  '\n',
  '\r',
  VERTICAL_TAB,
  FORM_FEED,
  NEXT_LINE,
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
];

/** Positions generated rather than hand-listed: a guard that only handles the character standing
 * alone still lets a doubled, leading, trailing, or already-backslashed one through. */
function hostileCellPayloads(character: string): string[] {
  return [
    character,
    `${character}${character}`,
    `${character}leading`,
    `trailing${character}`,
    `split${character}here`,
    `\\${character}`,
    `${character}\\`,
    `clear ${character}| Acme Tower | outstanding remediation liability of 99,000,000 dollars`,
  ];
}

/** A row whose cells all read as separator cells re-keys every row under it, so the whole family a
 * reader accepts as one is generated: any dash run, either alignment colon or both, with and
 * without the surrounding spaces GFM permits. */
function separatorCellPayloads(): string[] {
  const payloads: string[] = [];
  for (let dashes = 1; dashes <= 5; dashes += 1) {
    for (const [left, right] of [
      ['', ''],
      [':', ''],
      ['', ':'],
      [':', ':'],
    ]) {
      const cell = `${left}${'-'.repeat(dashes)}${right}`;
      payloads.push(cell, ` ${cell} `);
    }
  }
  return payloads;
}

const HOSTILE_CELL_PAYLOADS = [
  ...STRUCTURAL_CHARACTERS.flatMap(hostileCellPayloads),
  ...separatorCellPayloads(),
].map((payload) => [JSON.stringify(payload), payload] as const);

/**
 * Row compositions, not single cells: whether a separator-shaped cell can re-key anything depends
 * on the row it sits in, so the sweep is parameterised over both — every separator form, at the
 * first and last column, across narrow and wide rows.
 */
const SEPARATOR_CELL_CASES = separatorCellPayloads().flatMap((payload) =>
  [2, 4].flatMap((columnCount) =>
    [0, columnCount - 1].map((position) => ({
      label: JSON.stringify(payload),
      payload,
      columnCount,
      position,
    })),
  ),
);

// Column count 1 included deliberately: in a single-column table one cell is the whole row, so a
// lone separator-shaped cell forges a separator row there even though the identical cell forges
// nothing beside a real value.
const SEPARATOR_ROW_CASES = separatorCellPayloads().flatMap((payload) =>
  [1, 2, 4].map((columnCount) => ({
    label: JSON.stringify(payload),
    payload,
    columnCount,
  })),
);

/** Rows whose cells mix separator forms — a reader takes the row as a separator when every cell is
 * separator-shaped, not when they all take the same shape, so a uniform-row check would miss these.
 * Drawn from both ends of the generated form list, which is ordered by dash count. */
const MIXED_SEPARATOR_ROWS = [2, 3, 4].flatMap((columnCount) => [
  separatorCellPayloads().slice(0, columnCount),
  separatorCellPayloads().slice(-columnCount),
]);

/** The text the parser actually emitted for one cell — the expectation for a producer test is what
 * the real parser produced, not what the source bytes said, so a parser that normalizes a line
 * break is compared against what it did rather than what it was handed. */
function parsedCellText(elements: readonly ParsedElement[], cell: string): string {
  const found = elements.find(
    (element) => element.locator.kind === 'xlsx-cell' && element.locator.cell === cell,
  );
  if (!found) {
    throw new Error(`The parser emitted no element for cell ${cell}`);
  }
  return found.text;
}

describe('chunkElements', () => {
  it('should return no chunks for an empty element list', () => {
    expect(chunkElements([])).toEqual([]);
  });

  describe('prose — heading boundaries', () => {
    it('should never merge two elements from different heading paths into one chunk, even when both are tiny', () => {
      const elements = [
        docxElement(0, 'Section one body.', ['Section 1']),
        docxElement(1, 'Section two body.', ['Section 2']),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe('Section one body.');
      expect(chunks[1].text).toBe('Section two body.');
      expect((chunks[0].locator as DocxParagraphLocator).headingPath).toEqual(['Section 1']);
      expect((chunks[1].locator as DocxParagraphLocator).headingPath).toEqual(['Section 2']);
    });

    it('should merge consecutive elements sharing one heading path into a single chunk', () => {
      const elements = [
        docxElement(0, 'First paragraph.', ['Intro']),
        docxElement(1, 'Second paragraph.', ['Intro']),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('First paragraph.\n\nSecond paragraph.');
      // Anchored to the first spanned element — the locator type has no field for a range.
      expect((chunks[0].locator as DocxParagraphLocator).paragraphIndex).toBe(0);
    });
  });

  describe('prose — overlap', () => {
    it('should carry a tail of the closing chunk into the next chunk of the same run, and never into a chunk across a heading boundary', () => {
      // Long enough on its own, and long enough combined with a second element, to force the
      // window to close after the first element (chars/4 approximation, see chunker.ts).
      const elementAText = `${'filler '.repeat(286)}UNIQUETAILWORD`;
      const elementBText = `${'filler '.repeat(286)}UNIQUEHEADWORD`;
      const elements = [pdfElement(1, elementAText), pdfElement(2, elementBText)];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).not.toContain('UNIQUEHEADWORD');
      expect(chunks[1].text).toContain('UNIQUETAILWORD');
      expect(chunks[1].text).toContain('UNIQUEHEADWORD');
    });

    it('should not leak an in-run overlap tail into the first chunk of the next heading run', () => {
      const elementAText = `${'filler '.repeat(286)}TAILOFONE`;
      const elementBText = `${'filler '.repeat(286)}HEADOFTWO`;
      const elements = [
        // Same heading path, oversized together — forces a 2-chunk run whose second chunk
        // carries an overlap tail from the first.
        docxElement(0, elementAText, ['Section 1']),
        docxElement(1, elementBText, ['Section 1']),
        // A new heading path starts a fresh run; its chunk must not inherit that overlap.
        docxElement(2, 'short body', ['Section 2']),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(3);
      expect(chunks[1].text).toContain('TAILOFONE');
      expect(chunks[2].text).toBe('short body');
      expect(chunks[2].text).not.toContain('TAILOFONE');
      expect(chunks[2].text).not.toContain('HEADOFTWO');
    });
  });

  describe('prose — locators', () => {
    it('should keep a single-element chunk locator identical to its source element', () => {
      const elements = [pdfElement(3, 'short page text')];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].locator).toEqual(elements[0].locator);
      expect(chunks[0].elements).toEqual([
        { locator: elements[0].locator, text: elements[0].text },
      ]);
    });

    it('should drop boundingBox from a PDF locator once the chunk spans more than one page', () => {
      const elements = [pdfElement(1, 'page one text'), pdfElement(2, 'page two text')];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      const locator = chunks[0].locator as PdfPageLocator;
      expect(locator.kind).toBe('pdf-page');
      expect(locator.page).toBe(1);
      expect(locator.boundingBox).toBeUndefined();
      // Every spanned page's own locator/text still retained, even though the chunk's anchor
      // (asserted above) only ever names the first.
      expect(chunks[0].elements).toEqual([
        { locator: elements[0].locator, text: elements[0].text },
        { locator: elements[1].locator, text: elements[1].text },
      ]);
    });
  });

  describe('resolveCitationLocator', () => {
    it('should resolve a quote to the page it actually appears on within a multi-page chunk', () => {
      const elements = [
        pdfElement(1, 'Page one prose about zoning.'),
        pdfElement(2, 'Page two prose about parking.'),
        pdfElement(3, 'Page three prose about easements.'),
        pdfElement(4, 'Page four prose about the anchor tenant renewal option.'),
      ];
      const [chunk] = chunkElements(elements);

      const locator = resolveCitationLocator(chunk, 'anchor tenant renewal option');

      expect((locator as PdfPageLocator).page).toBe(4);
    });

    it("should fall back to the chunk's anchor locator when no single element contains the quote", () => {
      const elements = [pdfElement(1, 'Page one text.'), pdfElement(2, 'Page two text.')];
      const [chunk] = chunkElements(elements);

      const locator = resolveCitationLocator(chunk, 'a quote found nowhere in this chunk');

      expect(locator).toEqual(chunk.locator);
      expect((locator as PdfPageLocator).page).toBe(1);
    });

    // A quote matching more than one element resolves to the chunk's anchor locator, never to
    // whichever element `Array.find` reaches first — the data does not distinguish the pages.
    it("should fall back to the chunk's anchor locator when the quote matches more than one element", () => {
      const elements = [
        pdfElement(1, 'Property Report — Confidential'),
        pdfElement(2, 'Property Report — Confidential'),
      ];
      const [chunk] = chunkElements(elements);

      const locator = resolveCitationLocator(chunk, 'Property Report — Confidential');

      expect(locator).toEqual(chunk.locator);
      expect((locator as PdfPageLocator).page).toBe(1);
    });

    // The overlap prefix `flush()` splices onto the next chunk's `text` carries its own `elements`
    // entry, so a quote drawn from it resolves to the page it came from.
    it("should resolve a quote drawn from the overlap-prefix text to the page it actually came from, not the next chunk's own first page", () => {
      const elementAText = `${'filler '.repeat(286)}UNIQUETAILWORD`;
      const elementBText = `${'filler '.repeat(286)}UNIQUEHEADWORD`;
      const elements = [pdfElement(1, elementAText), pdfElement(2, elementBText)];
      const chunks = chunkElements(elements);

      const locator = resolveCitationLocator(chunks[1], 'UNIQUETAILWORD');

      expect((locator as PdfPageLocator).page).toBe(1);
    });

    // Regression: a `.lean()` read of a row written before `elements` existed returns
    // `elements: undefined`, not `[]` (`EvidenceChunk.elements`'s own doc comment) — this must fall
    // back to `chunk.locator` rather than throwing on `undefined.filter`.
    it("should fall back to the chunk's anchor locator for a chunk with no elements array, rather than throwing", () => {
      const elements = [pdfElement(1, 'Page one text.')];
      const [chunk] = chunkElements(elements);
      const legacyChunk = { ...chunk, elements: undefined };

      expect(() => resolveCitationLocator(legacyChunk, 'Page one text.')).not.toThrow();
      expect(resolveCitationLocator(legacyChunk, 'Page one text.')).toEqual(chunk.locator);
    });
  });

  describe('prose — oversized elements', () => {
    it("should split a single element whose own text exceeds the overflow threshold into several under-target chunks sharing that element's locator", () => {
      const bigText = `STARTMARKER ${'filler '.repeat(2200)}ENDMARKER`;
      const elements = [pdfElement(5, bigText)];

      const chunks = chunkElements(elements);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // Well under the ~2200-`filler`-word original's token count — proof the oversized page
        // was actually split, not merely re-chunked around the same single overrun element.
        expect(chunk.tokenCount).toBeLessThan(1000);
        expect((chunk.locator as PdfPageLocator).page).toBe(5);
      }
      expect(chunks[0].text).toContain('STARTMARKER');
      expect(chunks[chunks.length - 1].text).toContain('ENDMARKER');
      // No content lost across the split: every "filler" occurrence from the source element
      // survives somewhere in the split pieces' own retained element text. Not an exact-count
      // match — the overlap carried between consecutive chunks (`chunkProseRun`'s `flush`) also
      // appears as a leading `elements` entry on the chunk after it, so some occurrences
      // legitimately appear twice.
      const splitText = chunks.flatMap((chunk) => chunk.elements.map((element) => element.text));
      expect(splitText.join(' ').match(/filler/g)?.length ?? 0).toBeGreaterThanOrEqual(2200);
    });
  });

  describe('prose — CJK token counting', () => {
    it('should split a dense CJK page into multiple chunks instead of leaving it as one oversized chunk', () => {
      // No ASCII spaces — the normal case for CJK prose — and long enough that a real subword
      // tokenizer's roughly one-token-per-character count clears the overflow threshold, while
      // the old chars/4 approximation would have read it as comfortably under target.
      const cjkText = '評価額は一億二千万円です。'.repeat(150);
      const elements = [pdfElement(1, cjkText)];

      const chunks = chunkElements(elements);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.tokenCount).toBeLessThan(1000);
      }
    });

    it('should never corrupt an astral-plane CJK character at a hard-cut split boundary', () => {
      // CJK Extension B kanji (astral plane, U+20000+) occur in real Japanese personal- and
      // place-name registers. No ASCII spaces anywhere in this text, so every split below takes
      // the hard-cut path (`findWeightedSplitIndex`/`splitOversizedText`), and long enough
      // (400 repeats) to force several cuts, not just one.
      const text = '本件不動産の登記名義人は𠮟山𪚲氏である。'.repeat(400);
      const elements = [pdfElement(1, text)];

      const chunks = chunkElements(elements);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // `isWellFormed()` is false exactly when a string contains a lone surrogate — the shape a
        // cut through the middle of an astral character produces. A lone surrogate cannot encode
        // to UTF-8, so a well-formed string here is also a lossless UTF-8 round-trip.
        expect(chunk.text.isWellFormed()).toBe(true);
        expect(Buffer.from(chunk.text, 'utf-8').toString('utf-8')).toBe(chunk.text);
        for (const element of chunk.elements) {
          expect(element.text.isWellFormed()).toBe(true);
        }
      }
    });

    it('should weight an astral-plane Han character as one full CJK token, not two half-weighted code units', () => {
      // At 1-per-code-point weight (correct for a CJK character on any plane), 1000 repeats weighs
      // 1000 — over `OVERFLOW_THRESHOLD` (805). Weighted per UTF-16 code unit instead, each astral
      // character's two surrogate halves would weigh 0.25 apiece (500 total, under threshold), so
      // this only splits when CJK characters are weighted per code point.
      const astralText = '𠮟'.repeat(1000);
      const elements = [pdfElement(1, astralText)];

      const chunks = chunkElements(elements);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should not weight a Private Use Area character as CJK when sizing a chunk', () => {
      // U+E000 sits in the Private Use Area, outside every `\p{Script=…}` member in
      // `CJK_CHARACTER_PATTERN` — PDF extractors emit PUA code points for unmapped glyphs. At
      // chars/4 weighting this text stays one chunk (2000/4 = 500 tokens, under
      // `OVERFLOW_THRESHOLD`); weighted as CJK it would split into several.
      const puaText = String.fromCharCode(0xe000).repeat(2000);
      const elements = [pdfElement(1, puaText)];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
    });

    // OVERFLOW_THRESHOLD (805) + OVERLAP_TOKENS (84) — the ceiling `approxTokenCount`,
    // `tailForOverlap`, and `findWeightedSplitIndex` share one code-point weight definition to
    // hold, regardless of which script or plane the source text is on.
    it.each([
      ['BMP Han', '評価額は一億二千万円です。'.repeat(400)],
      ['astral Han (Ext B)', '𠮟山𪚲'.repeat(500)],
      ['Latin', 'filler '.repeat(2200)],
      // Family emoji ZWJ sequences: astral code points joined by U+200D (BMP) — exercises the
      // non-CJK astral weighting path, never CJK.
      ['emoji ZWJ sequences', '👨‍👩‍👧‍👦'.repeat(600)],
    ])(
      'should keep every chunk within OVERFLOW_THRESHOLD + OVERLAP_TOKENS for %s text',
      (_label, text) => {
        const chunks = chunkElements([pdfElement(1, text)]);

        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.tokenCount).toBeLessThanOrEqual(889);
        }
      },
    );
  });

  describe('prose — lease-summary.docx fixture (manifest-driven)', () => {
    it('should chunk exactly on the manifest heading-path runs, anchored to each run’s first paragraph', async () => {
      const content = await readFile(DOCX_FIXTURE_PATH);
      const parsed = await new DocxParser().parse(content);
      const paragraphs = manifest.files['lease-summary.docx'].paragraphs;

      // Independently derive expected run boundaries from the manifest, rather than from the
      // chunker's own grouping — otherwise the test would just restate the implementation.
      const expectedRuns: { startIndex: number; headingPath: readonly string[] }[] = [];
      let previousKey: string | undefined;
      paragraphs.forEach((paragraph, index) => {
        const key = JSON.stringify(paragraph.headingPath);
        if (key !== previousKey) {
          expectedRuns.push({ startIndex: index, headingPath: paragraph.headingPath });
          previousKey = key;
        }
      });

      const chunks = chunkElements(parsed.elements);

      expect(chunks).toHaveLength(expectedRuns.length);
      chunks.forEach((chunk, index) => {
        const locator = chunk.locator as DocxParagraphLocator;
        expect(locator.kind).toBe('docx-paragraph');
        expect(locator.paragraphIndex).toBe(expectedRuns[index].startIndex);
        expect(locator.headingPath).toEqual(expectedRuns[index].headingPath);
      });
    });
  });

  describe('spreadsheet — header repetition and windowing', () => {
    it('should repeat the header row in every window once row content forces more than one window', () => {
      const bigCell = 'x'.repeat(800);
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Col1'),
        xlsxCellElement('Sheet1', 'B1', 'Col2'),
        xlsxCellElement('Sheet1', 'A2', bigCell),
        xlsxCellElement('Sheet1', 'B2', bigCell),
        xlsxCellElement('Sheet1', 'A3', bigCell),
        xlsxCellElement('Sheet1', 'B3', bigCell),
        xlsxCellElement('Sheet1', 'A4', bigCell),
        xlsxCellElement('Sheet1', 'B4', bigCell),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(3);
      // Each window's own row span, not the header row through every window's end — the latter
      // made window 2 and window 3's ranges silently contain window 1's rows too (see
      // `chunkSheet`'s `flush`).
      const ranges = chunks.map((chunk) => (chunk.locator as XlsxRegionLocator).range);
      expect(ranges).toEqual(['A2:B2', 'A3:B3', 'A4:B4']);
      for (const chunk of chunks) {
        expect(chunk.text).toContain('| Col1 | Col2 |');
        expect(chunk.text).toContain('| --- | --- |');
        expect((chunk.locator as XlsxRegionLocator).sheetName).toBe('Sheet1');
      }
    });

    // Every window's range starts at its own first data row, so windows partition the sheet
    // rather than overlap it.
    it('should emit row-window ranges that never overlap each other', () => {
      const bigCell = 'x'.repeat(800);
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Col1'),
        xlsxCellElement('Sheet1', 'B1', 'Col2'),
        xlsxCellElement('Sheet1', 'A2', bigCell),
        xlsxCellElement('Sheet1', 'B2', bigCell),
        xlsxCellElement('Sheet1', 'A3', bigCell),
        xlsxCellElement('Sheet1', 'B3', bigCell),
        xlsxCellElement('Sheet1', 'A4', bigCell),
        xlsxCellElement('Sheet1', 'B4', bigCell),
      ];

      const chunks = chunkElements(elements);
      const rowSpans = chunks.map((chunk) => {
        const [startCell, endCell] = (chunk.locator as XlsxRegionLocator).range.split(':');
        return {
          start: Number(/\d+$/.exec(startCell)?.[0]),
          end: Number(/\d+$/.exec(endCell)?.[0]),
        };
      });

      for (let i = 0; i < rowSpans.length; i += 1) {
        for (let j = i + 1; j < rowSpans.length; j += 1) {
          const overlaps =
            rowSpans[i].start <= rowSpans[j].end && rowSpans[j].start <= rowSpans[i].end;
          expect(overlaps).toBe(false);
        }
      }
    });

    // Every window's range claims only the columns its own rows occupy.
    it("should narrow a window's range to only the columns its own rows actually occupy, not the sheet-wide column union", () => {
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Col1'),
        xlsxCellElement('Sheet1', 'B1', 'Col2'),
        xlsxCellElement('Sheet1', 'C1', 'Col3'),
        xlsxCellElement('Sheet1', 'D1', 'Col4'),
        xlsxCellElement('Sheet1', 'E1', 'Col5'),
        xlsxCellElement('Sheet1', 'A2', 'a2'),
        xlsxCellElement('Sheet1', 'B2', 'b2'),
        xlsxCellElement('Sheet1', 'C2', 'c2'),
        xlsxCellElement('Sheet1', 'A3', 'a3'),
        xlsxCellElement('Sheet1', 'B3', 'b3'),
        xlsxCellElement('Sheet1', 'C3', 'c3'),
        xlsxCellElement('Sheet1', 'A4', 'a4'),
        xlsxCellElement('Sheet1', 'B4', 'b4'),
        xlsxCellElement('Sheet1', 'C4', 'c4'),
        xlsxCellElement('Sheet1', 'A5', 'a5'),
        xlsxCellElement('Sheet1', 'B5', 'b5'),
        xlsxCellElement('Sheet1', 'C5', 'c5'),
        // A new window (SHEET_ROWS_PER_WINDOW = 4) starts at row 6, touching only D/E — columns
        // this window never occupies must not appear in its range.
        xlsxCellElement('Sheet1', 'D6', 'd6'),
        xlsxCellElement('Sheet1', 'E6', 'e6'),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(2);
      const ranges = chunks.map((chunk) => (chunk.locator as XlsxRegionLocator).range);
      expect(ranges).toEqual(['A2:C5', 'D6:E6']);
    });

    it('should fill missing cells in a data row as blank markdown columns', () => {
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Col1'),
        xlsxCellElement('Sheet1', 'B1', 'Col2'),
        xlsxCellElement('Sheet1', 'A2', 'only-a'),
        // B2 intentionally absent — mirrors the parser skipping a blank cell.
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('| only-a |  |');
    });

    // Regression: a data row with a value in a column the header row itself left blank used to
    // lose that column entirely, because the old column set came only from the header row's own
    // cells. The column union is now every column occupied at or below the header row.
    it('should widen the column set to include a column occupied only by a data row, not just the header row', () => {
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Col1'),
        xlsxCellElement('Sheet1', 'B1', 'Col2'),
        xlsxCellElement('Sheet1', 'A2', 'only-a'),
        xlsxCellElement('Sheet1', 'C2', 'extra'),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('| Col1 | Col2 |  |');
      expect(chunks[0].text).toContain('| only-a |  | extra |');
      // The window's own row span (its one data row), not the header row through that row.
      expect((chunks[0].locator as XlsxRegionLocator).range).toBe('A2:C2');
    });
  });

  describe('spreadsheet — report-layout preamble', () => {
    it('should emit one preamble region chunk for the rows above the detected header, keeping a sheet title citable', () => {
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Q1 2025 Comparable Sales Report'),
        xlsxCellElement('Sheet1', 'A2', 'Property Name'),
        xlsxCellElement('Sheet1', 'B2', 'Sale Date'),
        xlsxCellElement('Sheet1', 'A3', 'Acme Tower'),
        xlsxCellElement('Sheet1', 'B3', '2025-01-15'),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(2);
      const preamble = chunks[0].locator as XlsxRegionLocator;
      expect(preamble.kind).toBe('xlsx-region');
      // The preamble's own occupied column (A only) — not the table's A:B span, which the title
      // row never actually touches.
      expect(preamble.range).toBe('A1:A1');
      expect(chunks[0].text).toContain('Q1 2025 Comparable Sales Report');
      // The preamble chunk never carries the table's header/separator markdown — it is not a
      // data window.
      expect(chunks[0].text).not.toContain('| --- |');

      const table = chunks[1].locator as XlsxRegionLocator;
      // The window's own data row span (row 3, its only data row) — not the header row (row 2)
      // through row 3, which would make the range claim the header row as part of the data span.
      expect(table.range).toBe('A3:B3');
      expect(chunks[1].text).toContain('| Property Name | Sale Date |');
      expect(chunks[1].text).toContain('| Acme Tower | 2025-01-15 |');

      // A header-cell citation resolves to the header row (row 2), not the data window's own A3:B3
      // range, which never contained it.
      const headerLocator = resolveCitationLocator(chunks[1], 'Property Name');
      expect((headerLocator as XlsxRegionLocator).range).toBe('A2:B2');
      const dataLocator = resolveCitationLocator(chunks[1], 'Acme Tower');
      expect((dataLocator as XlsxRegionLocator).range).toBe('A3:B3');
    });

    it('should emit no preamble chunk when the header row is already the topmost occupied row', () => {
      const elements = [
        xlsxCellElement('Sheet1', 'A1', 'Property Name'),
        xlsxCellElement('Sheet1', 'B1', 'Sale Date'),
        xlsxCellElement('Sheet1', 'A2', 'Acme Tower'),
        xlsxCellElement('Sheet1', 'B2', '2025-01-15'),
      ];

      const chunks = chunkElements(elements);

      expect(chunks).toHaveLength(1);
      expect((chunks[0].locator as XlsxRegionLocator).range).toBe('A2:B2');
    });
  });

  /**
   * Cell text is untrusted document content serialized into a structured grammar, so the property
   * under test is that no cell content can add, split, or re-key a row: the table a reader gets back
   * always has the rows, columns and keys the sheet actually had, and every cell still decodes to
   * exactly the text it was built from.
   */
  describe('spreadsheet — structural cell text', () => {
    const HEADER_ROW = ['Property Name', 'Remediation Notes'];

    it.each(HOSTILE_CELL_PAYLOADS)(
      'should keep the table intact when a data cell holds %s',
      (_label, payload) => {
        const rows = [
          HEADER_ROW,
          ['Acme Tower', 'site inspected, no remediation required'],
          ['Bravo Plaza', payload],
          [payload, 'clear'],
        ];

        const chunks = chunkElements(sheetGrid(rows));

        expect(chunks).toHaveLength(1);
        expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
      },
    );

    it.each(HOSTILE_CELL_PAYLOADS)(
      'should keep the table intact when a header cell holds %s',
      (_label, payload) => {
        const rows = [
          ['Property Name', `Remediation Notes ${payload}`],
          ['Acme Tower', 'site inspected, no remediation required'],
          ['Bravo Plaza', 'clear'],
        ];

        const chunks = chunkElements(sheetGrid(rows));

        expect(chunks).toHaveLength(1);
        expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
      },
    );

    /**
     * `STRUCTURAL_CHARACTERS` is a claim about which characters carry structure; this is what makes
     * it falsifiable. Every code point the language can express goes through the real chunker as a
     * whole cell, and the table it lands in must come back with the same rows, columns and keys.
     * Lone surrogates are the one exclusion: they are not text and cannot survive a UTF-8 round
     * trip, so no document can deliver one.
     */
    it('should keep the table intact for every Unicode code point standing alone in a cell', () => {
      const rowsPerWindow = 4;
      const batchSize = rowsPerWindow * 4;
      let violationCount = 0;
      const sampleViolations: string[] = [];

      const runBatch = (payloads: readonly string[]): void => {
        const dataRows = payloads.map((payload, index) => [`Row ${index + 1}`, payload]);
        const chunks = chunkElements(sheetGrid([HEADER_ROW, ...dataRows]));

        chunks.forEach((chunk, chunkIndex) => {
          const windowRows = dataRows.slice(
            chunkIndex * rowsPerWindow,
            chunkIndex * rowsPerWindow + rowsPerWindow,
          );
          const violation = describeTableShapeViolation(chunk.text, [HEADER_ROW, ...windowRows]);
          if (violation === undefined) {
            return;
          }
          violationCount += 1;
          if (sampleViolations.length < 10) {
            const codePoints = windowRows
              .map(([, payload]) => `U+${(payload.codePointAt(0) ?? 0).toString(16)}`)
              .join(', ');
            sampleViolations.push(`${codePoints}: ${violation}`);
          }
        });
      };

      let batch: string[] = [];
      for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          continue;
        }
        batch.push(String.fromCodePoint(codePoint));
        if (batch.length === batchSize) {
          runBatch(batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        runBatch(batch);
      }

      expect({ violationCount, sampleViolations }).toEqual({
        violationCount: 0,
        sampleViolations: [],
      });
    }, 600_000);

    it('should keep a cell holding a literal pipe or a line break readable and citable', () => {
      const rows = [
        ['Property Name', 'Address', 'Remediation Notes'],
        ['Acme Tower', '12 Main St | Suite 400', 'inspected 2025-01-15\nno remediation required'],
      ];

      const chunks = chunkElements(sheetGrid(rows));

      expect(chunks).toHaveLength(1);
      expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
      // Citability: the emitted data row is quotable verbatim out of the chunk a citation names,
      // and resolves to the element that actually holds it rather than the header element.
      const dataLine = chunks[0].text.split(ROW_BREAK_PATTERN)[2];
      expect(locateQuote(dataLine, chunks[0].text).kind).toBe('exact');
      expect(resolveCitationLocator(chunks[0], dataLine)).toEqual(chunks[0].elements[1].locator);
    });

    it('should keep the table intact when an RFC 4180 quoted field forges a row, end to end from CSV bytes', async () => {
      const csv = [
        'Property Name,Remediation Notes',
        'Acme Tower,"site inspected, no remediation required"',
        'Bravo Plaza,"clear |\n| Acme Tower | outstanding remediation liability of 99,000,000 dollars"',
      ].join('\r\n');

      const parsed = await new CsvParser(',', ['text/csv']).parse(Buffer.from(csv, 'utf8'));
      const chunks = chunkElements(parsed.elements);

      const rows = [
        ['A1', 'B1'],
        ['A2', 'B2'],
        ['A3', 'B3'],
      ].map((cells) => cells.map((cell) => parsedCellText(parsed.elements, cell)));
      expect(chunks).toHaveLength(1);
      expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
      // The forged row never becomes a row of its own: the whole table is header, separator, two
      // data rows.
      expect(chunks[0].text.split(ROW_BREAK_PATTERN)).toHaveLength(4);
    });

    it('should keep the table intact when a multiline cell forges a row, end to end from XLSX bytes', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Property Name';
      sheet.getCell('B1').value = 'Remediation Notes';
      sheet.getCell('A2').value = 'Acme Tower';
      sheet.getCell('B2').value = 'site inspected, no remediation required';
      sheet.getCell('A3').value = 'Bravo Plaza';
      // What Alt+Enter puts in a cell: a line break inside one cell's own text.
      sheet.getCell('B3').value =
        'clear |\n| Acme Tower | outstanding remediation liability of 99,000,000 dollars';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const parsed = await new XlsxParser().parse(content);
      const chunks = chunkElements(parsed.elements);

      const rows = [
        ['A1', 'B1'],
        ['A2', 'B2'],
        ['A3', 'B3'],
      ].map((cells) => cells.map((cell) => parsedCellText(parsed.elements, cell)));
      expect(chunks).toHaveLength(1);
      expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
      expect(chunks[0].text.split(ROW_BREAK_PATTERN)).toHaveLength(4);
    });
  });

  /**
   * A reader takes a row as a header separator only when every one of its cells is separator-shaped,
   * so that whole-row shape is the forgeable one and a lone dash among real values is not. The
   * distinction is worth drawing precisely: accounting number format renders zero as `-`, so a
   * financial model holds columns of them, and an escape applied to those would put a character in
   * front of a reader that the document never contained.
   */
  describe('spreadsheet — separator-shaped cells', () => {
    it.each(SEPARATOR_CELL_CASES)(
      'should leave $label unescaped among ordinary values ($columnCount columns, position $position)',
      ({ payload, columnCount, position }) => {
        const rows = [
          Array.from({ length: columnCount }, (_cell, index) => `Column ${index + 1}`),
          Array.from({ length: columnCount }, (_cell, index) =>
            index === position ? payload : `value ${index + 1}`,
          ),
        ];

        const chunks = chunkElements(sheetGrid(rows));

        expect(chunks).toHaveLength(1);
        expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
        // Byte-identical, not merely decodable: this cell is what a citation shows a reader as
        // verbatim evidence, so an escape here is a character the document never held.
        const dataLine = chunks[0].text.split(ROW_BREAK_PATTERN)[2];
        expect(rawCellSegments(dataLine)[position]).toBe(payload);
      },
    );

    it.each(SEPARATOR_ROW_CASES)(
      'should neutralize a row whose every cell holds $label ($columnCount columns)',
      ({ payload, columnCount }) => {
        const rows = [
          Array.from({ length: columnCount }, (_cell, index) => `Column ${index + 1}`),
          Array.from({ length: columnCount }, (_cell, index) => `value ${index + 1}`),
          Array.from({ length: columnCount }, () => payload),
        ];

        const chunks = chunkElements(sheetGrid(rows));

        expect(chunks).toHaveLength(1);
        expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
        const forgedLine = chunks[0].text.split(ROW_BREAK_PATTERN)[3];
        expect(isSeparatorRow(forgedLine)).toBe(false);
      },
    );

    it.each(MIXED_SEPARATOR_ROWS.map((cells) => ({ label: JSON.stringify(cells), cells })))(
      'should neutralize a row mixing separator forms $label',
      ({ cells }) => {
        const rows = [
          cells.map((_cell, index) => `Column ${index + 1}`),
          cells.map((_cell, index) => `value ${index + 1}`),
          cells,
        ];

        const chunks = chunkElements(sheetGrid(rows));

        expect(chunks).toHaveLength(1);
        expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
        const forgedLine = chunks[0].text.split(ROW_BREAK_PATTERN)[3];
        expect(isSeparatorRow(forgedLine)).toBe(false);
      },
    );

    it('should leave a whole accounting column of dash-rendered zeros exactly as the sheet holds them', () => {
      const rows = [
        ['Line Item', 'FY24', 'FY25'],
        ['Repairs & Maintenance', '-', '12,400'],
        ['Capital Reserve', '-', '-'],
        ['Ground Rent', '-', '-'],
      ];

      const chunks = chunkElements(sheetGrid(rows));

      expect(chunks).toHaveLength(1);
      expect(describeTableShapeViolation(chunks[0].text, rows)).toBeUndefined();
      const dataLines = chunks[0].text.split(ROW_BREAK_PATTERN).slice(2);
      expect(dataLines.map((line) => rawCellSegments(line))).toEqual(rows.slice(1));
    });
  });

  describe('spreadsheet — comps.xlsx fixture (manifest-driven)', () => {
    it('should serialize the manifest header row into every chunk and keep ranges within the manifest usedRange', async () => {
      const content = await readFile(XLSX_FIXTURE_PATH);
      const parsed = await new XlsxParser().parse(content);
      const sheet = manifest.files['comps.xlsx'].sheets[0];

      const chunks = chunkElements(parsed.elements);

      expect(chunks.length).toBeGreaterThan(0);
      const headerLine = `| ${sheet.headerRow.join(' | ')} |`;
      for (const chunk of chunks) {
        expect(chunk.text).toContain(headerLine);
        const locator = chunk.locator as XlsxRegionLocator;
        expect(locator.kind).toBe('xlsx-region');
        expect(locator.sheetName).toBe(sheet.name);
        // usedRange is 'A1:H11' — every chunk's range must stay within those bounds.
        const [, endCell] = locator.range.split(':');
        const endRow = Number(/\d+$/.exec(endCell)?.[0]);
        expect(endRow).toBeLessThanOrEqual(11);
      }
    });

    it("should split the sheet's 10 data rows into several row-window chunks, not one chunk covering the whole sheet", async () => {
      // Regression: a comps-sized sheet's markdown never approaches the (prose-sized) token
      // overflow threshold on its own, so without a row cap dedicated to spreadsheets the whole
      // sheet collapsed into a single chunk — defeating row-window citation precision and handing
      // every downstream chunk-scoped lookup (e.g. conflict-forcing) the whole table at once.
      const content = await readFile(XLSX_FIXTURE_PATH);
      const parsed = await new XlsxParser().parse(content);
      const sheet = manifest.files['comps.xlsx'].sheets[0];

      const chunks = chunkElements(parsed.elements);

      expect(sheet.rowCount).toBe(10);
      expect(chunks.length).toBeGreaterThan(1);
      const headerLine = `| ${sheet.headerRow.join(' | ')} |`;
      for (const chunk of chunks) {
        expect(chunk.text).toContain(headerLine);
      }
    });
  });
});
