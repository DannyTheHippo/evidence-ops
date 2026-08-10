import type {
  EvidenceLocator,
  XlsxCellLocator,
  XlsxRegionLocator,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { Chunk } from './chunk.type';
import type { ParsedElement } from './parsers/parsed-element.type';

// No tokenizer dependency: chars/4 is the standard order-of-magnitude approximation for English
// text (the same rule of thumb OpenAI documents for its own models). It is only ever used to size
// a soft window target, never for anything that needs an exact count, so the imprecision is fine.
function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
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

/** Slices the trailing ~`tokenTarget` tokens off `text`, breaking on a word boundary so the
 * overlap prefix spliced into the next chunk never starts mid-word. */
function tailForOverlap(text: string, tokenTarget: number): string {
  const charTarget = tokenTarget * 4;
  if (text.length <= charTarget) {
    return text;
  }
  const slice = text.slice(text.length - charTarget);
  const boundary = slice.indexOf(' ');
  return boundary === -1 ? slice : slice.slice(boundary + 1);
}

/**
 * Fills ~`TARGET_TOKENS`-sized windows from a run of elements that already share one heading
 * path (the caller never hands this a run crossing a heading boundary). A single element larger
 * than the target is never split mid-element — chunk boundaries only ever fall between elements,
 * since the parser is what defines the smallest addressable span, and slicing inside one would
 * produce a chunk this module cannot locate.
 */
function chunkProseRun(elements: readonly ParsedElement[]): Chunk[] {
  const chunks: Chunk[] = [];
  let bufferElements: ParsedElement[] = [];
  let bufferText = '';
  let overlapPrefix = '';

  const flush = (): void => {
    if (bufferElements.length === 0) {
      return;
    }
    const text = overlapPrefix ? `${overlapPrefix} ${bufferText}` : bufferText;
    chunks.push({
      text,
      tokenCount: approxTokenCount(text),
      locator: anchorLocator(bufferElements),
    });
    overlapPrefix = tailForOverlap(bufferText, OVERLAP_TOKENS);
    bufferElements = [];
    bufferText = '';
  };

  for (const element of elements) {
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

function toMarkdownRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/**
 * Row-window region chunks for one sheet. The header row is repeated verbatim in every window —
 * without it a window of bare numbers carries no column meaning for an embedding — so each
 * window's markdown is the header, the separator, and only that window's data rows.
 */
function chunkSheet(sheetName: string, elements: readonly ParsedElement[]): Chunk[] {
  const cells: SheetCell[] = elements.map((element) => {
    const locator = element.locator as XlsxCellLocator;
    return { ...parseCellAddress(locator.cell), text: element.text };
  });
  const extractorVersion = elements[0].locator.extractorVersion;

  // The header row is the topmost row this sheet's elements actually touch, not a hardcoded row
  // 1 — derivable from the elements themselves rather than assumed.
  const headerRowNumber = Math.min(...cells.map((cell) => cell.row));
  const headerCells = cells
    .filter((cell) => cell.row === headerRowNumber)
    .sort((a, b) => columnIndex(a.column) - columnIndex(b.column));
  const columns = headerCells.map((cell) => cell.column);
  const firstColumn = columns[0];
  const lastColumn = columns[columns.length - 1];

  const headerMarkdown = [
    toMarkdownRow(headerCells.map((cell) => cell.text)),
    toMarkdownRow(columns.map(() => '---')),
  ].join('\n');

  const dataRowNumbers = Array.from(
    new Set(cells.filter((cell) => cell.row !== headerRowNumber).map((cell) => cell.row)),
  ).sort((a, b) => a - b);

  const rowMarkdown = (rowNumber: number): string => {
    const rowCellsByColumn = new Map(
      cells.filter((cell) => cell.row === rowNumber).map((cell) => [cell.column, cell.text]),
    );
    return toMarkdownRow(columns.map((column) => rowCellsByColumn.get(column) ?? ''));
  };

  const chunks: Chunk[] = [];
  let windowRows: number[] = [];
  let windowText = headerMarkdown;

  const flush = (): void => {
    if (windowRows.length === 0) {
      return;
    }
    const endRow = windowRows[windowRows.length - 1];
    const locator: XlsxRegionLocator = {
      kind: 'xlsx-region',
      sheetName,
      range: `${firstColumn}${headerRowNumber}:${lastColumn}${endRow}`,
      extractorVersion,
    };
    chunks.push({ text: windowText, tokenCount: approxTokenCount(windowText), locator });
    windowRows = [];
    windowText = headerMarkdown;
  };

  for (const rowNumber of dataRowNumbers) {
    const line = rowMarkdown(rowNumber);
    const candidateText =
      windowRows.length === 0 ? `${headerMarkdown}\n${line}` : `${windowText}\n${line}`;

    if (windowRows.length > 0 && approxTokenCount(candidateText) > OVERFLOW_THRESHOLD) {
      flush();
      windowText = `${headerMarkdown}\n${line}`;
      windowRows = [rowNumber];
    } else {
      windowText = candidateText;
      windowRows.push(rowNumber);
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
