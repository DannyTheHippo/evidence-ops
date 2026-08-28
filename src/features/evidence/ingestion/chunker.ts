import type {
  EvidenceLocator,
  XlsxCellLocator,
  XlsxRegionLocator,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { locateQuote } from '../../../shared/utils/locate-quote.util';
import type { Chunk, ChunkElement } from './chunk.type';
import type { ParsedElement } from './parsers/parsed-element.type';
import { detectHeaderRow } from './sheet-header';

/**
 * Folded into every chunk id (`compute-chunk-id.ts`). Bump it whenever a change here can alter the
 * text or the boundaries of the chunks this module emits: an id is a claim about what a chunk is,
 * and a citation stored against one chunker resolves to a span a differently-behaving chunker may
 * never produce. A locator's `extractorVersion` covers the same hazard for parsers and says nothing
 * about this module, which contributes no coordinate to a locator.
 */
export const CHUNKER_VERSION = 'chunker-1';

// Han, Hiragana, Katakana, and Hangul — the scripts a chars/4 ratio most badly misjudges. Unicode
// script property escapes, not a hand-rolled code-point range: `\p{Script=…}` matches only real
// script members, astral-plane characters included, and needs the `u` flag to do it. A hand-rolled
// range literal covering "CJK Compatibility Ideographs" is one typo away from the neighboring "CJK
// Unified Ideographs" block, or worse, from swallowing the surrogate block and the whole Private
// Use Area into "full CJK weight". Not `g`: used one character at a time below, and a stateful
// global regex's `lastIndex` would make repeated `.test()` calls on the same instance silently skip
// matches.
const CJK_CHARACTER_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// No tokenizer dependency: a real subword tokenizer segments CJK text at roughly one token per
// character, not the chars/4 ratio that holds for whitespace-delimited English — counting every
// CJK character as a full token and everything else at chars/4 is only an order-of-magnitude
// approximation either way, but it is the approximation that does not put a CJK document several
// times over `TARGET_TOKENS` while reading as compliant. Used only to size a soft window target,
// never anywhere that needs an exact count.
//
// Walked by code point (`for...of`), both for the CJK count and for the non-CJK remainder, so this
// shares one weight definition with `tailForOverlap` and `findWeightedSplitIndex` below (1 per CJK
// code point, 0.25 per non-CJK code point). `text.length` counts UTF-16 code units, not code
// points, and would silently double-weight every astral character (CJK Extension B and beyond, and
// non-CJK astral text like emoji) relative to what those two functions compute for the same input.
function approxTokenCount(text: string): number {
  let cjkCount = 0;
  let codePointCount = 0;
  for (const char of text) {
    codePointCount += 1;
    if (CJK_CHARACTER_PATTERN.test(char)) {
      cjkCount += 1;
    }
  }
  return Math.ceil(cjkCount + (codePointCount - cjkCount) / 4);
}

// Target window size, shared by prose and spreadsheet chunking for one soft budget across the
// pipeline. A window may run up to 15% over target before it is closed — closing exactly at
// target would mean the very next element almost always tips it over, splitting the input roughly
// twice as often as necessary.
const TARGET_TOKENS = 700;
const OVERFLOW_THRESHOLD = TARGET_TOKENS * 1.15;
// Within the required 10-15% band.
const OVERLAP_RATIO = 0.12;
const OVERLAP_TOKENS = Math.round(TARGET_TOKENS * OVERLAP_RATIO);

// A real comparables-style sheet (a handful of narrow columns, short cell values) rarely comes
// close to `OVERFLOW_THRESHOLD` even across its full row count — a 10-row, 8-column comps sheet
// serializes to a few hundred tokens, well under 700, so the token budget alone never splits it
// and the whole sheet becomes one chunk. That defeats row-window chunking's actual purpose (a
// citation resolving to a handful of rows, not an entire table, and a narrower blast radius for
// any chunk-scoped fact lookup). Spreadsheets get their own, much smaller cap, independent of the
// prose token budget: a window closes at whichever comes first, this row count or the shared
// token overflow (the latter still protects a sheet with unusually wide/long cell content).
const SHEET_ROWS_PER_WINDOW = 4;

function headingRunKey(headingPath: readonly string[]): string {
  return JSON.stringify(headingPath);
}

/**
 * The locator variants for a single page/paragraph (`PdfPageLocator`/`DocxParagraphLocator`) have
 * no field for a multi-element span, so a chunk that groups several elements anchors to the first
 * one — the closest addressable point a citation can still verify against. A PDF page's
 * `boundingBox` describes only that one page, though, so it is dropped once the chunk's text runs
 * past that page; keeping it would assert a location the chunk does not actually cover.
 */
function anchorLocator(elements: readonly ParsedElement[]): EvidenceLocator {
  const first = elements[0].locator;
  if (elements.length === 1 || first.kind !== 'pdf-page') {
    return first;
  }
  return { kind: 'pdf-page', page: first.page, extractorVersion: first.extractorVersion };
}

/** Slices the trailing ~`tokenTarget` tokens off `text`, weighted the same way `approxTokenCount`
 * counts (walked backward from the end), so a CJK tail is not handed a chars/4-sized slice several
 * times larger than its real token weight — an oversized overlap prefix would by itself be enough to
 * push the next chunk over `OVERFLOW_THRESHOLD`. Breaks on a word boundary where the script has one,
 * so the overlap prefix spliced into the next chunk never starts mid-word. Walked by code point
 * (`[...text]`), never by UTF-16 code unit — a backward walk over raw indices can stop between the
 * two code units of an astral character (CJK Extension B and beyond), and slicing there hands the
 * next chunk a lone surrogate that cannot round-trip through UTF-8. */
function tailForOverlap(text: string, tokenTarget: number): string {
  if (approxTokenCount(text) <= tokenTarget) {
    return text;
  }
  const codePoints = [...text];
  let weight = 0;
  let startIndex = text.length;
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const char = codePoints[index];
    weight += CJK_CHARACTER_PATTERN.test(char) ? 1 : 0.25;
    startIndex -= char.length;
    if (weight >= tokenTarget) {
      break;
    }
  }
  const slice = text.slice(startIndex);
  const boundary = slice.indexOf(' ');
  return boundary === -1 ? slice : slice.slice(boundary + 1);
}

/** The UTF-16 code-unit index at which `text`'s accumulated `approxTokenCount` weight first reaches
 * `tokenTarget` — walked per code point (`for...of`, the same iteration `approxTokenCount` itself
 * uses), so a run of CJK characters (weight 1 each) is not handed a chars/4-sized slice four times
 * too large for its actual token weight, and an astral character (CJK Extension B and beyond) is
 * never split between its two code units. The returned index always lands after a complete code
 * point, because it advances by that code point's own `.length` (1 or 2) rather than by 1. Returns
 * `text.length` if the whole string stays under target. */
function findWeightedSplitIndex(text: string, tokenTarget: number): number {
  let weight = 0;
  let index = 0;
  for (const char of text) {
    weight += CJK_CHARACTER_PATTERN.test(char) ? 1 : 0.25;
    index += char.length;
    if (weight >= tokenTarget) {
      return index;
    }
  }
  return text.length;
}

/** Slices `text` into ~`tokenTarget`-sized pieces, breaking on a word boundary where the script
 * has one and hard-cutting where it does not (the normal case for CJK, which carries no spaces). */
function splitOversizedText(text: string, tokenTarget: number): string[] {
  const pieces: string[] = [];
  let remaining = text;
  while (approxTokenCount(remaining) > tokenTarget) {
    const cutIndex = findWeightedSplitIndex(remaining, tokenTarget);
    const boundary = remaining.slice(0, cutIndex).lastIndexOf(' ');
    const cut = boundary > 0 ? boundary : cutIndex;
    pieces.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining.length > 0) {
    pieces.push(remaining);
  }
  return pieces;
}

/**
 * An element whose own text alone already exceeds `OVERFLOW_THRESHOLD` is split into
 * `TARGET_TOKENS`-sized pieces, each still carrying that element's own locator and heading path —
 * a page or paragraph locator names only that element, not a position within it, so several pieces
 * sharing one locator asserts nothing the locator does not already cover. Left unsplit, one dense
 * page would become a chunk `chunkProseRun`'s own windowing never revisits, over target with no
 * further chance to close — and `VoyageEmbeddingProvider` truncates rather than rejecting an
 * oversized input (`truncation: true`), so the tail would be silently dropped from the embedding
 * with no error anywhere.
 */
function splitOversizedElement(element: ParsedElement): ParsedElement[] {
  if (approxTokenCount(element.text) <= OVERFLOW_THRESHOLD) {
    return [element];
  }
  return splitOversizedText(element.text, TARGET_TOKENS).map((text) => ({ ...element, text }));
}

/**
 * Fills ~`TARGET_TOKENS`-sized windows from a run of elements that already share one heading
 * path (the caller never hands this a run crossing a heading boundary). An element larger than
 * `OVERFLOW_THRESHOLD` on its own is pre-split (`splitOversizedElement`) before windowing runs, so
 * every window this function builds still closes near `TARGET_TOKENS` — chunk boundaries otherwise
 * only ever fall between elements, since the parser is what defines the smallest addressable span.
 */
function chunkProseRun(elements: readonly ParsedElement[]): Chunk[] {
  const expandedElements = elements.flatMap(splitOversizedElement);
  const chunks: Chunk[] = [];
  let bufferElements: ParsedElement[] = [];
  let bufferText = '';
  let overlapPrefix = '';
  // The retained element a citation into `overlapPrefix` should resolve to — set at the end of one
  // flush from that closing chunk's own last element, consumed as the first `elements` entry of the
  // *next* chunk. `bufferElements` never receives it: `anchorLocator(bufferElements)` must keep
  // anchoring to the chunk's own first element, not to text borrowed from the chunk before it.
  let overlapSource: ChunkElement | undefined;

  const flush = (): void => {
    if (bufferElements.length === 0) {
      return;
    }
    const text = overlapPrefix ? `${overlapPrefix} ${bufferText}` : bufferText;
    const ownElements = bufferElements.map((element): ChunkElement => ({
      locator: element.locator,
      text: element.text,
    }));
    chunks.push({
      text,
      tokenCount: approxTokenCount(text),
      locator: anchorLocator(bufferElements),
      elements: overlapSource ? [overlapSource, ...ownElements] : ownElements,
    });
    const tail = tailForOverlap(bufferText, OVERLAP_TOKENS);
    overlapPrefix = tail;
    // Attributed to this chunk's own closing element — page/paragraph elements run far larger than
    // `OVERLAP_TOKENS` (84 at the current target), so the tail practically never reaches back past
    // it; this is the approximation for the rare case it does.
    overlapSource = { locator: bufferElements[bufferElements.length - 1].locator, text: tail };
    bufferElements = [];
    bufferText = '';
  };

  for (const element of expandedElements) {
    const candidateText = bufferText ? `${bufferText}\n\n${element.text}` : element.text;
    const candidateTokens = approxTokenCount(candidateText);

    if (bufferElements.length > 0 && candidateTokens > OVERFLOW_THRESHOLD) {
      flush();
      bufferElements = [element];
      bufferText = element.text;
    } else {
      bufferElements.push(element);
      bufferText = candidateText;
    }
  }
  flush();

  return chunks;
}

/**
 * Prose chunking (PDF pages, DOCX paragraphs): groups elements run-by-run, where a run is the
 * longest consecutive stretch sharing one `headingPath`. Splitting at every heading change first —
 * before any token-budget windowing — is what makes "never merge across a heading-path boundary"
 * absolute rather than a soft preference the token target could override.
 */
function chunkProse(elements: readonly ParsedElement[]): Chunk[] {
  const chunks: Chunk[] = [];
  let run: ParsedElement[] = [];
  let runKey: string | undefined;

  for (const element of elements) {
    const key = headingRunKey(element.headingPath);
    if (runKey !== undefined && key !== runKey) {
      chunks.push(...chunkProseRun(run));
      run = [];
    }
    run.push(element);
    runKey = key;
  }
  chunks.push(...chunkProseRun(run));

  return chunks;
}

interface SheetCell {
  readonly column: string;
  readonly row: number;
  readonly text: string;
}

function parseCellAddress(cell: string): { column: string; row: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  if (!match) {
    throw new Error(`Cell address '${cell}' is not in A1 notation`);
  }
  return { column: match[1], row: Number(match[2]) };
}

function columnIndex(column: string): number {
  let index = 0;
  for (const char of column) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

// Built from code points rather than typed as source escapes: each renders as an invisible
// character a reviewer reading this file cannot tell apart from the next.
const VERTICAL_TAB = String.fromCharCode(0x0b);
const FORM_FEED = String.fromCharCode(0x0c);
const NEXT_LINE = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** The `\uXXXX` spelling of one character, for the structural characters with no conventional
 * single-letter escape and for building a character class that cannot be broken by the raw
 * characters it is made of. */
function toUnicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/**
 * Every character that carries structure in the markdown table `toMarkdownRow` emits, mapped to the
 * escape that spells it: the cell delimiter, every code point a reader or JavaScript's own regex
 * engine takes as a line break, and the backslash the escapes are written with — left raw, a cell
 * holding one could spell an escape of its own and break the row anyway.
 *
 * Every escape is reversible, so a cell holding a genuine pipe or a genuine multi-line note reads
 * back as the text the document held and stays citable. A character outside this map is emitted
 * verbatim, which is the failure direction to know about: the table is only as safe as this
 * enumeration is complete, so completeness is verified by driving every Unicode code point through
 * `chunkElements` in `test/features/evidence/ingestion/chunker.spec.ts` rather than asserted here.
 */
const CELL_ESCAPE_BY_CHARACTER = new Map<string, string>([
  ['\\', '\\\\'],
  ['|', '\\|'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  [VERTICAL_TAB, '\\v'],
  [FORM_FEED, '\\f'],
  [NEXT_LINE, toUnicodeEscape(NEXT_LINE)],
  [LINE_SEPARATOR, toUnicodeEscape(LINE_SEPARATOR)],
  [PARAGRAPH_SEPARATOR, toUnicodeEscape(PARAGRAPH_SEPARATOR)],
]);

// Built from the map's own keys so the two cannot drift: a character added to the map is escaped
// without a second edit, and a character matched here but absent from the map is impossible.
const CELL_ESCAPE_PATTERN = new RegExp(
  `[${Array.from(CELL_ESCAPE_BY_CHARACTER.keys()).map(toUnicodeEscape).join('')}]`,
  'g',
);

// A cell a reader takes as a header-separator cell: GFM's dash run, with either alignment colon,
// inside the spaces `toMarkdownRow`'s joins put around every cell.
const SEPARATOR_CELL_PATTERN = /^\s*:?-+:?\s*$/;

/**
 * Serializes one cell's text so a reader can only ever take it as cell content. Cell text is
 * untrusted document content — a spreadsheet cell holds whatever its author typed — and the table
 * around it is the grammar a model reads entity/metric associations out of, so a cell able to spell
 * a row break or a cell delimiter can add or split a row no document ever contained.
 */
function escapeCellText(text: string): string {
  return text.replace(
    CELL_ESCAPE_PATTERN,
    (character) => CELL_ESCAPE_BY_CHARACTER.get(character) ?? character,
  );
}

/**
 * Escapes the leading dash of every cell in a row a reader would take as a header separator, which
 * is how a data row re-keys the rows under it. Scoped to the whole row because that is the whole of
 * the forgeable shape: a reader accepts a separator row only when every one of its cells is
 * separator-shaped, so a lone dash beside real values forges nothing and is left exactly as the
 * document wrote it — accounting number format renders zero as `-`, which puts whole columns of
 * them in an ordinary financial model, and each one is evidence a citation quotes verbatim.
 *
 * Applies to the escaped cells, because a reader's view of the row is what decides it. Escaping a
 * dash leaves the cell reading as the dashes it holds and decodes back to them.
 */
function neutralizeSeparatorRow(escapedCells: readonly string[]): readonly string[] {
  return escapedCells.every((cell) => SEPARATOR_CELL_PATTERN.test(cell))
    ? escapedCells.map((cell) => cell.replace('-', '\\-'))
    : escapedCells;
}

function toMarkdownRow(cells: readonly string[]): string {
  const escapedCells = neutralizeSeparatorRow(cells.map((cell) => escapeCellText(cell)));
  return `| ${escapedCells.join(' | ')} |`;
}

/** The header-separator row for a table of `columnCount` columns. Structure rather than content, so
 * it is built here instead of passed through `toMarkdownRow` — the escaping there exists precisely
 * to stop cell text from spelling this row. */
function toMarkdownSeparatorRow(columnCount: number): string {
  return `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
}

/** Every column actually occupied by a cell in `rowNumbers`, sorted left to right — a region's own
 * span, not the sheet-wide column set `columns` (below) unions across the whole table. Used to build
 * a locator range that names only the columns a specific region (the preamble, the header row, one
 * data window) genuinely holds. */
function columnsForRows(cells: readonly SheetCell[], rowNumbers: readonly number[]): string[] {
  const rows = new Set(rowNumbers);
  return Array.from(
    new Set(cells.filter((cell) => rows.has(cell.row)).map((cell) => cell.column)),
  ).sort((a, b) => columnIndex(a) - columnIndex(b));
}

/** An A1-notation range spanning `startRow`-`endRow` across `regionColumns`. `regionColumns` comes
 * from real occupied cells (`columnsForRows`), so it is empty only when a region was built over rows
 * that hold no cells at all — a construction bug upstream, not a sheet shape to degrade for. Thrown
 * rather than interpolating `undefined` into the range string: a locator naming a page the reader
 * cannot find is worse than a loud ingestion failure. */
function regionRange(regionColumns: readonly string[], startRow: number, endRow: number): string {
  if (regionColumns.length === 0) {
    throw new Error(
      `xlsx region spans rows ${startRow}-${endRow} but touches no occupied column — cannot build a range locator`,
    );
  }
  return `${regionColumns[0]}${startRow}:${regionColumns[regionColumns.length - 1]}${endRow}`;
}

/**
 * Row-window region chunks for one sheet. The header row is repeated verbatim in every window —
 * without it a window of bare numbers carries no column meaning for an embedding — so each
 * window's markdown is the header, the separator, and only that window's data rows. A window
 * closes at `SHEET_ROWS_PER_WINDOW` rows or the shared token overflow, whichever comes first (see
 * that constant's doc comment for why row count needs its own, smaller cap).
 */
function chunkSheet(sheetName: string, elements: readonly ParsedElement[]): Chunk[] {
  const cells: SheetCell[] = elements.map((element) => {
    const locator = element.locator as XlsxCellLocator;
    return { ...parseCellAddress(locator.cell), text: element.text };
  });
  const extractorVersion = elements[0].locator.extractorVersion;

  // detectHeaderRow (sheet-header.ts) finds the real header row rather than assuming the topmost
  // occupied row is it — a report-layout sheet with a title above the table needs the real header,
  // not row 1, or the union below silently drops every data column.
  const headerRowNumber = detectHeaderRow(cells);

  // The column set is the union of every column occupied at or below the header row, not just the
  // header row's own cells — a ragged header (a data row with a value in a column the header left
  // blank) still contributes its column to this union. Only used to size every window's markdown
  // consistently (every row renders the same column count); locator ranges use `columnsForRows` on
  // the region's own rows instead, never this sheet-wide union.
  const columns = Array.from(
    new Set(cells.filter((cell) => cell.row >= headerRowNumber).map((cell) => cell.column)),
  ).sort((a, b) => columnIndex(a) - columnIndex(b));

  const headerTextByColumn = new Map(
    cells.filter((cell) => cell.row === headerRowNumber).map((cell) => [cell.column, cell.text]),
  );
  const headerMarkdown = [
    toMarkdownRow(columns.map((column) => headerTextByColumn.get(column) ?? '')),
    toMarkdownSeparatorRow(columns.length),
  ].join('\n');

  const dataRowNumbers = Array.from(
    new Set(cells.filter((cell) => cell.row > headerRowNumber).map((cell) => cell.row)),
  ).sort((a, b) => a - b);

  const rowMarkdown = (rowNumber: number): string => {
    const rowCellsByColumn = new Map(
      cells.filter((cell) => cell.row === rowNumber).map((cell) => [cell.column, cell.text]),
    );
    return toMarkdownRow(columns.map((column) => rowCellsByColumn.get(column) ?? ''));
  };

  const chunks: Chunk[] = [];

  // Rows above the header (a title, a report-layout preamble) are not part of the table, but
  // discarding them outright would make a sheet's title uncitable — one region chunk keeps them
  // retrievable without folding them into the header/data windowing below.
  const preambleRowNumbers = Array.from(
    new Set(cells.filter((cell) => cell.row < headerRowNumber).map((cell) => cell.row)),
  ).sort((a, b) => a - b);
  if (preambleRowNumbers.length > 0) {
    const preambleText = preambleRowNumbers.map((rowNumber) => rowMarkdown(rowNumber)).join('\n');
    const preambleLocator: XlsxRegionLocator = {
      kind: 'xlsx-region',
      sheetName,
      range: regionRange(
        columnsForRows(cells, preambleRowNumbers),
        preambleRowNumbers[0],
        preambleRowNumbers[preambleRowNumbers.length - 1],
      ),
      extractorVersion,
    };
    chunks.push({
      text: preambleText,
      tokenCount: approxTokenCount(preambleText),
      locator: preambleLocator,
      elements: [],
    });
  }

  // The header row's own retained element, prepended to every window's `elements` below — a
  // citation quoting a column header then resolves (`resolveCitationLocator`) to a range that
  // actually contains the header row, rather than to `windowText`'s data range, which does not.
  const headerColumns = columnsForRows(cells, [headerRowNumber]);
  const headerElement: ChunkElement = {
    locator: {
      kind: 'xlsx-region',
      sheetName,
      range: regionRange(headerColumns, headerRowNumber, headerRowNumber),
      extractorVersion,
    },
    text: toMarkdownRow(columns.map((column) => headerTextByColumn.get(column) ?? '')),
  };

  let windowRows: number[] = [];
  let windowDataLines: string[] = [];
  let windowText = headerMarkdown;

  const flush = (): void => {
    if (windowRows.length === 0) {
      return;
    }
    // The window's own first/last data row, not `headerRowNumber` — anchoring the range's start to
    // the header row would make each window's range span every window before it too (window 2's
    // range would cover window 1's rows), so windows meant to partition the sheet would instead
    // overlap it. The header row is still repeated in `windowText` for column context, and named
    // precisely by `headerElement` above; this range only needs to name the rows this window
    // actually holds. Columns come from `columnsForRows` on this window's own rows, not the
    // sheet-wide `columns` union — a window whose rows occupy only a few columns claims only that
    // span.
    const startRow = windowRows[0];
    const endRow = windowRows[windowRows.length - 1];
    const locator: XlsxRegionLocator = {
      kind: 'xlsx-region',
      sheetName,
      range: regionRange(columnsForRows(cells, windowRows), startRow, endRow),
      extractorVersion,
    };
    chunks.push({
      text: windowText,
      tokenCount: approxTokenCount(windowText),
      locator,
      elements: [headerElement, { locator, text: windowDataLines.join('\n') }],
    });
    windowRows = [];
    windowDataLines = [];
    windowText = headerMarkdown;
  };

  for (const rowNumber of dataRowNumbers) {
    const line = rowMarkdown(rowNumber);
    const candidateText =
      windowRows.length === 0 ? `${headerMarkdown}\n${line}` : `${windowText}\n${line}`;

    if (
      windowRows.length > 0 &&
      (windowRows.length >= SHEET_ROWS_PER_WINDOW ||
        approxTokenCount(candidateText) > OVERFLOW_THRESHOLD)
    ) {
      flush();
      windowText = `${headerMarkdown}\n${line}`;
      windowRows = [rowNumber];
      windowDataLines = [line];
    } else {
      windowText = candidateText;
      windowRows.push(rowNumber);
      windowDataLines.push(line);
    }
  }
  flush();

  return chunks;
}

function chunkSpreadsheet(elements: readonly ParsedElement[]): Chunk[] {
  const bySheet = new Map<string, ParsedElement[]>();
  for (const element of elements) {
    const sheetName = (element.locator as XlsxCellLocator).sheetName;
    const sheetElements = bySheet.get(sheetName) ?? [];
    sheetElements.push(element);
    bySheet.set(sheetName, sheetElements);
  }

  const chunks: Chunk[] = [];
  for (const [sheetName, sheetElements] of bySheet) {
    chunks.push(...chunkSheet(sheetName, sheetElements));
  }
  return chunks;
}

/**
 * Entry point: dispatches on the locator kind of the first element. A `ParsedDocument` is always
 * homogeneous — one parser produces every element in it, and each parser emits exactly one
 * locator kind — so inspecting the first element is enough to route the whole document.
 */
export function chunkElements(elements: readonly ParsedElement[]): Chunk[] {
  if (elements.length === 0) {
    return [];
  }
  return elements[0].locator.kind === 'xlsx-cell'
    ? chunkSpreadsheet(elements)
    : chunkProse(elements);
}

/**
 * Resolves a citation's quote to the specific constituent element it actually came from, composing
 * `chunk.elements` (retained per-element text/locator pairs, including a leading overlap element
 * borrowed from the previous chunk where one exists — see `chunkProseRun`'s `flush`) with
 * `locateQuote`'s normalized containment check. This is what lets a quote from page 4 of a
 * multi-page chunk cite page 4, rather than `chunk.locator`'s anchor, which only ever names the
 * chunk's *first* spanned element (`anchorLocator`).
 *
 * Falls back to `chunk.locator` in three cases, neither of the first two of which a single element
 * locator can answer honestly: no element contains the quote at all (it spans more than one), or
 * more than one element does (repeated boilerplate — a footer, a caption, an identical clause on
 * two pages — inside the same chunk). Picking the first match in the second case would assert a
 * specific page the data does not actually distinguish; the chunk-level fallback is the precision
 * the evidence supports. The third: `chunk.elements` is `undefined` on a row written before that
 * field existed (`EvidenceChunk.elements`'s own doc comment — a Mongoose default never populates a
 * `.lean()` read), so this treats a missing array the same as an empty one rather than throwing.
 */
export function resolveCitationLocator(
  chunk: { readonly locator: EvidenceLocator; readonly elements?: readonly ChunkElement[] },
  quote: string,
): EvidenceLocator {
  const matches = (chunk.elements ?? []).filter(
    (element) => locateQuote(quote, element.text).kind === 'exact',
  );
  return matches.length === 1 ? matches[0].locator : chunk.locator;
}
