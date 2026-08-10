import { HttpStatus } from '@nestjs/common';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { BaseException } from '../../../../shared/exceptions/base.exception';
import type { XlsxCellLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { assertSafeArchive } from './safe-zip';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

// Mirrors the 'xlsx' entry of MIME_TYPE_TO_SOURCE_KIND (documents.constant.ts) — duplicated by
// design, see the equivalent comment in docx.parser.ts.
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Bump whenever a change here could shift the sheet/cell coordinates a stored citation points at.
const EXTRACTOR_VERSION = 'xlsx-exceljs-1';

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
        });
      });
    });

    return { elements, extractorVersion: EXTRACTOR_VERSION };
  }
}
