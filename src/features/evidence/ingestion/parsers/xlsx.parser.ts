import { HttpStatus } from '@nestjs/common';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { BaseException } from '../../../../shared/exceptions/base.exception';
import type { XlsxCellLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { assertSafeArchive, HostileArchiveException } from './safe-zip';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

// Mirrors the 'xlsx' entry of MIME_TYPE_TO_SOURCE_KIND (documents.constant.ts) — duplicated by
// design, see the equivalent comment in docx.parser.ts.
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Bump whenever a change here could shift the sheet/cell coordinates a stored citation points at.
const EXTRACTOR_VERSION = 'xlsx-exceljs-2';

/**
 * A legitimate merge in a lease/comps-style workbook spans at most a modest header banner — a
 * handful of columns, one or two rows. This sits far above that, so no real document trips it,
 * while still refusing a `<mergeCell ref="A1:XFD1048576"/>`-style range before the row/column
 * loop below would ever have to walk it cell by cell.
 */
const MAX_MERGE_RANGE_CELLS = 5_000;

/**
 * The finest granularity this parser emits is one element per non-empty or merge-covered cell, so
 * this bounds the total memory and downstream chunking cost of one workbook regardless of whether
 * the volume comes from a large cell count or from merge expansion. `assertSafeArchive` and
 * `MAX_MERGE_RANGE_CELLS` bound the archive and any single merge; this is the backstop against
 * exceljs's own load-time cell expansion, which is unbounded by anything in this file.
 */
const MAX_TOTAL_EMITTED_ELEMENTS = 20_000;

export class MalformedXlsxException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

function addThousandsSeparators(digits: string): string {
  const [integerPart, fractionPart] = digits.split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;
}

/**
 * `cell.text` does not apply the cell's number format — for a `0.00%`-formatted cell holding the
 * fraction `0.0525` it returns the literal string `"0.0525"`, not `"5.25%"` (verified against
 * fixtures/data-room/comps.xlsx). Conflict detection compares figures as a reader would see them
 * across formats, so this reimplements the display side of the handful of Excel number-format
 * tokens the fixtures actually use: a percent suffix, a fixed decimal count, thousands grouping,
 * and a literal prefix (e.g. `$`). It is not a general Excel number-format interpreter.
 */
function formatNumber(value: number, numFmt: string | undefined): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);

  if (!numFmt || numFmt === 'General') {
    return `${sign}${magnitude}`;
  }

  const sections = numFmt.split(';');
  const section = value < 0 && sections.length > 1 ? sections[1] : sections[0];

  const isPercent = section.includes('%');
  const scaled = isPercent ? magnitude * 100 : magnitude;

  const decimalMatch = /\.(0+)/.exec(section);
  const decimals = decimalMatch ? decimalMatch[1].length : 0;
  const useThousands = section.includes(',');
  // A literal prefix is whatever non-format characters precede the first digit/decimal/percent
  // token — covers a plain `$`, which is all the fixtures use; it does not decode `[$...]`
  // locale-currency tokens or quoted literals.
  const prefixMatch = /^([^#0.,%\s]+)/.exec(section);
  const prefix = !isPercent && prefixMatch ? prefixMatch[1] : '';

  let formatted = scaled.toFixed(decimals);
  if (useThousands) {
    formatted = addThousandsSeparators(formatted);
  }

  return `${sign}${prefix}${formatted}${isPercent ? '%' : ''}`;
}

/**
 * Resolves what a reader would actually see in the cell. Recurses once for formula cells, whose
 * displayed value is their cached `result`, formatted the same way as any other cell of that
 * number format — a formula's source text is never what a citation should quote.
 */
function displayTextForValue(
  value: ExcelJS.CellValue,
  numFmt: string | undefined,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return formatNumber(value, numFmt);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if ('error' in value) {
    return value.error;
  }
  if ('richText' in value) {
    return value.richText.map((run) => run.text).join('');
  }
  if ('formula' in value || 'sharedFormula' in value) {
    return value.result === undefined ? undefined : displayTextForValue(value.result, numFmt);
  }
  if ('hyperlink' in value) {
    return value.text;
  }
  return undefined;
}

interface MergeBounds {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

// Mirrors chunker.ts's own local A1-notation helpers — duplicated by design (see e.g.
// xlsx-fact-extractor.ts's identical comment): this module parses cell addresses to resolve a
// merge range's bounding box, an unrelated purpose to either of those modules', so sharing an
// import would couple modules that have no other reason to depend on each other.
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

/**
 * Fails CLOSED: a merge range whose bounding box covers more than `MAX_MERGE_RANGE_CELLS` cells is
 * rejected here, before any caller loops over it — a compliant-looking archive can declare a merge
 * spanning the entire addressable sheet, and the cost of that is the rectangle itself, not
 * anything `assertSafeArchive`'s declared-size checks can see.
 */
function decodeMergeRange(range: string): MergeBounds {
  const [topLeft, bottomRight] = range.split(':');
  const start = parseCellAddress(topLeft);
  const end = parseCellAddress(bottomRight ?? topLeft);
  const bounds: MergeBounds = {
    top: start.row,
    left: columnIndex(start.column),
    bottom: end.row,
    right: columnIndex(end.column),
  };

  const cellCount = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
  if (cellCount > MAX_MERGE_RANGE_CELLS) {
    throw new HostileArchiveException(
      `Merge range "${range}" covers ${cellCount} cells, exceeding the ${MAX_MERGE_RANGE_CELLS} limit`,
    );
  }

  return bounds;
}

/**
 * Fails CLOSED: rejects the workbook once the running count of emitted elements exceeds
 * `MAX_TOTAL_EMITTED_ELEMENTS`, whether the volume came from ordinary non-empty cells or from
 * merge-range expansion.
 */
function assertWithinEmittedElementBudget(elementCount: number): void {
  if (elementCount > MAX_TOTAL_EMITTED_ELEMENTS) {
    throw new HostileArchiveException(
      `Workbook emits more than ${MAX_TOTAL_EMITTED_ELEMENTS} elements`,
    );
  }
}

/**
 * Emits one element per non-empty cell — the finest granularity `XlsxCellLocator` can address,
 * and what makes a conflict-detection citation resolvable to the exact cell rather than a region
 * that merely contains it.
 */
export class XlsxParser implements DocumentParser {
  readonly supports = [XLSX_MIME_TYPE];

  async parse(content: Buffer): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(content);
    } catch (error) {
      throw new MalformedXlsxException('Could not open the file as a zip archive', error);
    }
    assertSafeArchive(zip);

    const workbook = new ExcelJS.Workbook();
    try {
      // exceljs/index.d.ts:1 shadows the ambient `Buffer` with a module-local
      // `interface Buffer extends ArrayBuffer {}`, so `Xlsx.load`'s declared parameter type is
      // that shadow, not Node's real `Buffer` — structurally incompatible under the newer
      // resizable-ArrayBuffer members in the ESNext lib, and not nameable from outside exceljs's
      // own module. `Parameters<...>[0]` recovers that exact (bogus) shadow type so the cast
      // bridges exceljs's own type definition rather than weakening this parser's `content:
      // Buffer` contract.
      await workbook.xlsx.load(content as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch (error) {
      throw new MalformedXlsxException('Could not parse the workbook', error);
    }

    const elements: ParsedElement[] = [];

    workbook.eachSheet((worksheet) => {
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.master !== cell) {
            // A merge-covered cell (exceljs re-points every covered cell at its master on load,
            // via Worksheet#_parseMergeCells — `cell.master` differs from `cell` itself only for
            // one of these). Its raw `.value` already equals the master's, but it keeps its own
            // `.numFmt`, so formatting it here can diverge from the master's display text (e.g. a
            // covered cell with no format showing `0.0525` next to the master's `5.25%`). The
            // merge pass below re-emits every covered cell using the master's own display text
            // instead, so skip it here rather than emit a value this cell's own format would
            // mangle.
            return;
          }

          const text = displayTextForValue(cell.value, cell.numFmt);
          if (text === undefined || text.trim() === '') {
            return;
          }

          const locator: XlsxCellLocator = {
            kind: 'xlsx-cell',
            sheetName: worksheet.name,
            cell: cell.address,
            extractorVersion: EXTRACTOR_VERSION,
          };

          elements.push({
            text: sanitizeEvidenceText(text),
            locator,
            headingPath: [],
          });
          assertWithinEmittedElementBudget(elements.length);
        });
      });

      // Propagates each merge range's master display text onto every cell it covers. exceljs
      // already points a covered cell's raw value at the master (see the skip above), but formats
      // it through the covered cell's own `numFmt` — not guaranteed to match the master's — so
      // text equality across a merge is not guaranteed by exceljs alone. Using the master's own
      // display text here makes it guaranteed: every covered cell ends up with the identical
      // (key, value) as the master, so spread across them is zero and conflict detection never
      // manufactures a false conflict out of a merge. That guarantee is what makes
      // `detectHeaderRow`'s distinct-value check in sheet-header.ts safe to lean on (a propagated
      // title has many non-empty cells but only one distinct value).
      for (const mergeRange of worksheet.model.merges) {
        const { top, left, bottom, right } = decodeMergeRange(mergeRange);
        const masterCell = worksheet.getCell(top, left);
        const masterText = displayTextForValue(masterCell.value, masterCell.numFmt);
        if (masterText === undefined || masterText.trim() === '') {
          continue;
        }
        const sanitizedText = sanitizeEvidenceText(masterText);

        for (let rowNumber = top; rowNumber <= bottom; rowNumber += 1) {
          for (let colNumber = left; colNumber <= right; colNumber += 1) {
            if (rowNumber === top && colNumber === left) {
              continue; // the master cell itself was already emitted by the eachRow pass above.
            }
            const coveredCell = worksheet.getCell(rowNumber, colNumber);
            const locator: XlsxCellLocator = {
              kind: 'xlsx-cell',
              sheetName: worksheet.name,
              cell: coveredCell.address,
              extractorVersion: EXTRACTOR_VERSION,
            };
            elements.push({
              text: sanitizedText,
              locator,
              headingPath: [],
            });
            assertWithinEmittedElementBudget(elements.length);
          }
        }
      }
    });

    return { elements, extractorVersion: EXTRACTOR_VERSION };
  }
}
