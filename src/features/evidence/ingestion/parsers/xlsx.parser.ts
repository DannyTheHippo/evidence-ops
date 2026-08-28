import { HttpStatus } from '@nestjs/common';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { BaseException } from '../../../../shared/exceptions/base.exception';
import type { XlsxCellLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  assertArchiveInflatesWithinBudget,
  assertSafeArchive,
  createInflateBudget,
  declaredUncompressedBytes,
} from './safe-zip';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';
// The upload gate's byte limit, imported rather than mirrored: this parser's own limits are
// defined in relation to it, and two copies of the number would let that relation break silently.
// `sources.service.ts` reads it the same way, for the same reason.
import { MAX_FILE_SIZE_BYTES } from '../../documents/documents.constant';

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
 * this bounds the element array and the downstream chunking cost of one workbook, whether the
 * volume comes from a large cell count or from merge expansion. It is not the memory bound on
 * loading the workbook — `MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES` and
 * `MAX_XLSX_ARCHIVE_INFLATED_BYTES` hold that, and both complete before exceljs builds its object
 * graph, while this count is only reachable afterwards.
 *
 * It sits above the corpus this parser serves — a fifteen-column rent roll or transaction history
 * ten thousand rows deep — and below what the worksheet-byte budget already admits, so it still
 * binds. A workbook past it is a bulk extract rather than a document cited cell by cell.
 */
const MAX_TOTAL_EMITTED_ELEMENTS = 200_000;

/**
 * The worksheet parts are what `workbook.xlsx.load()` turns into exceljs's in-memory
 * cell/style/shared-string object graph, at a multiple of the XML bytes they were written as, so
 * they carry a far tighter limit than the rest of the package. A workbook past this is a wide,
 * hundred-thousand-row extract — more spreadsheet than this parser supports, and nothing a data
 * room needs cited cell by cell.
 */
const MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

/**
 * The memory backstop over the whole package. `workbook.xlsx.load()` inflates every entry the
 * archive contains in full — worksheets, styles, document properties, media, and parts whose names
 * it recognizes nothing about — and only then decides what each one is, so what has to be bounded
 * before it runs is every entry, not the ones any list happens to name.
 *
 * Derived from the upload gate's own limit rather than restating a number, because a workbook the
 * API accepted must not then be refused for its size: this parser is downstream of
 * `MAX_FILE_SIZE_BYTES`, and a capacity limit below it would be the product contradicting itself.
 * The headroom above it is the worksheet budget, which covers the one way an accepted upload's
 * content grows on the way in — media and other already-compressed bulk inflate to about their
 * stored size, while XML inflates further, and the XML that inflates most is what the worksheet
 * budget already holds down.
 */
const MAX_XLSX_ARCHIVE_INFLATED_BYTES = MAX_FILE_SIZE_BYTES + MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES;

/**
 * `toFixed` accepts 0 to 100 fraction digits and throws a `RangeError` outside that range, while
 * the decimal count this parser feeds it comes from a cell's number format — document metadata,
 * carrying whatever the file's author put there.
 */
const MAX_FRACTION_DIGITS = 100;

export class MalformedXlsxException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/**
 * Fails CLOSED, as a capacity limit. Reads the ZIP central directory's declared `uncompressedSize`
 * — cheap, no decompression — and holds the worksheet parts to
 * `MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES` and the package as a whole to
 * `MAX_XLSX_ARCHIVE_INFLATED_BYTES`. A declaration is a statement a workbook makes about itself
 * and honest bulk reaches these numbers, so either overflow is `MalformedXlsxException` with the
 * guidance that acts on it: an operator whose own data-room export is too large is told that, not
 * that their file looks hostile.
 *
 * Only the worksheet limit reads part names, and it is a capacity limit on the parts that become
 * the largest object graph — never the memory bound. What bounds memory is
 * `assertArchiveInflatesWithinBudget`, which gates every entry whatever it is called, so a part
 * name this filter does not know still cannot inflate unbounded.
 */
function assertWithinDeclaredXlsxSizeBudget(zip: JSZip): void {
  let declaredArchiveBytes = 0;
  let declaredWorksheetBytes = 0;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      continue;
    }

    const declared = declaredUncompressedBytes(entry);
    declaredArchiveBytes += declared;
    if (declaredArchiveBytes > MAX_XLSX_ARCHIVE_INFLATED_BYTES) {
      throw new MalformedXlsxException(
        `Workbook declares more than ${MAX_XLSX_ARCHIVE_INFLATED_BYTES} uncompressed bytes ` +
          'across its parts, exceeding the size this parser supports — split the workbook or ' +
          'trim it to a smaller extract',
      );
    }

    if (entryName.startsWith('xl/worksheets/') || entryName === 'xl/sharedStrings.xml') {
      declaredWorksheetBytes += declared;
      if (declaredWorksheetBytes > MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES) {
        throw new MalformedXlsxException(
          `Workbook's worksheet data declares more than ${MAX_XLSX_WORKSHEET_UNCOMPRESSED_BYTES} ` +
            'uncompressed bytes, exceeding the size this parser supports — split the workbook or ' +
            'trim it to a smaller extract',
        );
      }
    }
  }
}

function addThousandsSeparators(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * What a cell renders as, plus the number format this parser declined to apply.
 *
 * `unsupportedFormat` carries the format string itself rather than a boolean so the caller can
 * report one reduced-fidelity reason per distinct format: a column of ten thousand cells sharing
 * one unreproducible format is one fact about the workbook, not ten thousand.
 */
interface DisplayText {
  readonly text: string;
  readonly unsupportedFormat?: string;
}

/**
 * One `;`-separated section of a number format, reduced to the parts that decide what it renders.
 *
 * `prefix` and `suffix` are the literal text on either side of the digit run, with the padding
 * (`_`), fill (`*`), escape (`\`), quoted-literal, colour and currency tokens already resolved.
 * The digit run itself is the placeholders — `0`, `#` and `?` — split at the decimal point.
 */
interface FormatSection {
  readonly prefix: string;
  readonly suffix: string;
  readonly integerPlaceholders: string;
  readonly fractionPlaceholders: string;
  readonly grouped: boolean;
  /** Trailing `,` tokens, each dividing the value by a thousand. */
  readonly thousandDivisions: number;
  /** `%` tokens, each multiplying the value by a hundred. */
  readonly percentMultipliers: number;
}

/** Bracket tokens that colour a cell without changing what it says. */
const COLOUR_TOKEN_PATTERN = /^(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d{1,2})$/i;

/** `0`, `#` and `?` are the three digit placeholders; every other character is literal or token. */
const DIGIT_PLACEHOLDER_PATTERN = /[0#?]/;

/**
 * Splits a number format into its sections. A bare `;` separates them, but a `;` inside a quoted
 * literal, inside a bracket token, or behind an escape/padding/fill token is content — splitting
 * on it would cut a section in half and silently shift which section every later value selects.
 */
function splitFormatSections(numFmt: string): string[] {
  const sections: string[] = [];
  let current = '';

  for (let index = 0; index < numFmt.length; index += 1) {
    const char = numFmt[index];
    if (char === '\\' || char === '_' || char === '*') {
      current += char + (numFmt[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '"' || char === '[') {
      const closer = char === '"' ? '"' : ']';
      const end = numFmt.indexOf(closer, index + 1);
      if (end === -1) {
        current += numFmt.slice(index);
        break;
      }
      current += numFmt.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === ';') {
      sections.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  sections.push(current);
  return sections;
}

/**
 * Reads one section into a {@link FormatSection}, or answers `undefined` for a section carrying
 * grammar this parser does not reproduce.
 *
 * Fails CLOSED on fidelity — every construct it cannot render exactly is refused rather than
 * approximated, because a number format decides what figure a reader sees and an approximation is
 * indistinguishable from the real value downstream. Refused here: scientific notation, fractions,
 * date and time tokens, conditional sections, digit placeholders interleaved with literals (a
 * `000-000-0000` phone format), and fraction placeholders other than `0`, whose trailing-separator
 * rendering this parser does not claim to match.
 *
 * Digit placeholders must form one contiguous run. That is the cut line between a format whose
 * figure can be emitted whole and one whose digits are threaded through literal text.
 */
/**
 * One lexical unit of a number-format section. `literal` is text a reader sees, `placeholder` is
 * one of `0`, `#` or `?`, `point` is the decimal separator, `comma` is the character that either
 * groups thousands or scales by one, and `percent` both scales by a hundred and prints itself —
 * which is why it is not simply a literal, since a `%` inside a quoted literal only prints.
 */
type SectionToken =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'placeholder'; readonly char: string }
  | { readonly kind: 'point' }
  | { readonly kind: 'comma' }
  | { readonly kind: 'percent' };

/**
 * Lexes one section, resolving the padding (`_`), fill (`*`), escape (`\`), quoted-literal, colour
 * and currency tokens into the text they contribute.
 *
 * Fails CLOSED on fidelity: answers `undefined` for any construct this parser does not reproduce
 * exactly — scientific notation, fractions, date and time tokens, conditional sections, and an
 * unterminated quote or bracket. A number format decides what figure a reader sees, so an
 * approximation of one is indistinguishable downstream from the value itself.
 */
function tokenizeSection(section: string): SectionToken[] | undefined {
  const tokens: SectionToken[] = [];

  for (let index = 0; index < section.length; index += 1) {
    const char = section[index];

    if (char === '\\') {
      tokens.push({ kind: 'literal', text: section[index + 1] ?? '' });
      index += 1;
      continue;
    }
    if (char === '"') {
      const end = section.indexOf('"', index + 1);
      if (end === -1) {
        return undefined;
      }
      tokens.push({ kind: 'literal', text: section.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (char === '_') {
      // Reserves the width of the next character. A reader sees a space where it sits.
      tokens.push({ kind: 'literal', text: ' ' });
      index += 1;
      continue;
    }
    if (char === '*') {
      // Repeats the next character to fill the column. Column width is presentation this parser
      // has no access to and a citation has no use for, so the fill contributes nothing; the
      // character it would repeat is still consumed so it cannot be read as a literal.
      index += 1;
      continue;
    }
    if (char === '[') {
      const end = section.indexOf(']', index + 1);
      if (end === -1) {
        return undefined;
      }
      const token = section.slice(index + 1, end);
      if (token.startsWith('$')) {
        // `[$SYMBOL-LOCALE]`: the locale identifier selects a rendering this parser does not vary
        // by, while the symbol is literal text a reader sees.
        const separator = token.indexOf('-');
        tokens.push({
          kind: 'literal',
          text: separator === -1 ? token.slice(1) : token.slice(1, separator),
        });
      } else if (!COLOUR_TOKEN_PATTERN.test(token)) {
        // A condition (`[<100]`) or an elapsed-time token (`[h]`).
        return undefined;
      }
      index = end;
      continue;
    }
    if (char === '%') {
      tokens.push({ kind: 'percent' });
      continue;
    }
    if (DIGIT_PLACEHOLDER_PATTERN.test(char)) {
      tokens.push({ kind: 'placeholder', char });
      continue;
    }
    if (char === '.') {
      tokens.push({ kind: 'point' });
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma' });
      continue;
    }
    if (char === '/' || /[A-Za-z]/.test(char)) {
      // A bare ASCII letter is a date, time or scientific-notation token — `y`, `m`, `d`, `h`,
      // `s`, `E`, `AM/PM`. Letters meant as text carry quotes or an escape and were consumed
      // above. `/` opens a fraction.
      return undefined;
    }
    tokens.push({ kind: 'literal', text: char });
  }

  return tokens;
}

/**
 * Assembles one section's tokens into a {@link FormatSection}, or answers `undefined` for a
 * section this parser does not reproduce.
 *
 * Fails CLOSED on fidelity, on top of what {@link tokenizeSection} already refuses: the digit
 * placeholders must form one contiguous run, and every fraction placeholder must be `0`. That
 * contiguity is the cut line between a format whose figure can be emitted whole and one whose
 * digits are threaded through literal text, where emitting the figure at all would mean emitting
 * format tokens as though they were the cell's value.
 */
function readFormatSection(section: string): FormatSection | undefined {
  const tokens = tokenizeSection(section);
  if (!tokens) {
    return undefined;
  }

  let prefix = '';
  let suffix = '';
  let integerPlaceholders = '';
  let fractionPlaceholders = '';
  let grouped = false;
  let thousandDivisions = 0;
  let percentMultipliers = 0;
  let seenDecimalPoint = false;
  let seenPlaceholder = false;
  let leftPlaceholders = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.kind === 'placeholder' || token.kind === 'point') {
      if (leftPlaceholders) {
        // Digits threaded through literal text — a `000-000-0000` phone format. The figure cannot
        // be emitted whole, and emitting it in pieces is how a format token reaches cell text.
        return undefined;
      }
      seenPlaceholder = true;
      if (token.kind === 'point') {
        if (seenDecimalPoint) {
          return undefined;
        }
        seenDecimalPoint = true;
      } else if (seenDecimalPoint) {
        fractionPlaceholders += token.char;
      } else {
        integerPlaceholders += token.char;
      }
      continue;
    }

    if (token.kind === 'comma') {
      if (seenPlaceholder && !leftPlaceholders) {
        // Inside the digit run a comma either groups thousands or, with no placeholder following
        // it, scales the value down by one.
        if (tokens[index + 1]?.kind === 'placeholder') {
          grouped = true;
        } else {
          thousandDivisions += 1;
        }
        continue;
      }
      if (leftPlaceholders) {
        suffix += ',';
      } else {
        prefix += ',';
      }
      continue;
    }

    const text = token.kind === 'percent' ? '%' : token.text;
    if (token.kind === 'percent') {
      percentMultipliers += 1;
    }
    if (seenPlaceholder) {
      leftPlaceholders = true;
      suffix += text;
    } else {
      prefix += text;
    }
  }

  // Fraction placeholders other than `0` render an insignificant digit as nothing or as a space,
  // and whether the decimal separator survives with them is not something this parser reproduces.
  if (/[^0]/.test(fractionPlaceholders)) {
    return undefined;
  }

  return {
    prefix,
    suffix,
    integerPlaceholders,
    fractionPlaceholders,
    grouped,
    thousandDivisions,
    percentMultipliers,
  };
}

/** Renders a non-negative magnitude through an already-read section. */
function renderFormatSection(section: FormatSection, magnitude: number): string {
  if (section.integerPlaceholders === '' && section.fractionPlaceholders === '') {
    return `${section.prefix}${section.suffix}`;
  }

  const scaled =
    (magnitude * 100 ** section.percentMultipliers) / 1000 ** section.thousandDivisions;
  // A format asking for more decimals than `toFixed` accepts renders at the ceiling. No format a
  // spreadsheet application produces reaches it — Excel's own editor stops at 30 — so clamping
  // costs nothing a reader would notice, while passing the raw count through would throw.
  const decimals = Math.min(section.fractionPlaceholders.length, MAX_FRACTION_DIGITS);
  const [rawInteger, fraction] = scaled.toFixed(decimals).split('.');

  const minimumIntegerDigits = section.integerPlaceholders.replace(/[^0]/g, '').length;
  // `#` and `?` show nothing where a digit would be insignificant, so a section declaring no `0`
  // in its integer part renders a zero integer as blank — which is how an Accounting format's
  // zero section shows a lone dash.
  let integer =
    rawInteger === '0' && minimumIntegerDigits === 0
      ? ''
      : rawInteger.padStart(minimumIntegerDigits, '0');
  if (section.grouped) {
    integer = addThousandsSeparators(integer);
  }

  const body = decimals > 0 ? `${integer}.${fraction}` : integer;
  return `${section.prefix}${body}${section.suffix}`;
}

/**
 * `cell.text` does not apply the cell's number format — for a `0.00%`-formatted cell holding the
 * fraction `0.0525` it returns the literal string `"0.0525"`, not `"5.25%"` (verified against
 * fixtures/data-room/comps.xlsx). Conflict detection compares figures as a reader would see them
 * across formats, so this renders the format the way Excel does.
 *
 * Section selection follows Excel's own grammar: one section formats every value and the parser
 * supplies the minus sign; two split positive-and-zero from negative; three or more give zero its
 * own section. From two sections up the negative section is applied verbatim — its own tokens
 * carry the sign, whether that is a literal `-`, a pair of parentheses, or nothing at all — so a
 * sign is never added on top of one the format already states, nor invented for one it omits.
 *
 * A format this parser cannot reproduce exactly returns the unformatted value together with the
 * format string, so the caller can say so out loud instead of the cell carrying a guess.
 */
function formatNumber(value: number, numFmt: string | undefined): DisplayText {
  const magnitude = Math.abs(value);
  const unformatted = `${value < 0 ? '-' : ''}${magnitude}`;

  if (!numFmt || numFmt === 'General') {
    return { text: unformatted };
  }

  const sections = splitFormatSections(numFmt);
  const selected =
    sections.length === 1
      ? sections[0]
      : value < 0
        ? sections[1]
        : value === 0 && sections.length > 2
          ? sections[2]
          : sections[0];
  const signed = sections.length === 1 && value < 0;

  const section = readFormatSection(selected);
  if (!section) {
    return { text: unformatted, unsupportedFormat: numFmt };
  }

  // Padding and fill tokens exist to align a column, so they render as leading and trailing space
  // that carries no meaning once the cell is quoted on its own.
  const rendered = renderFormatSection(section, magnitude).trim();
  return { text: signed && rendered !== '' ? `-${rendered}` : rendered };
}

/**
 * Resolves what a reader would actually see in the cell. Recurses once for formula cells, whose
 * displayed value is their cached `result`, formatted the same way as any other cell of that
 * number format — a formula's source text is never what a citation should quote.
 */
function displayTextForValue(
  value: ExcelJS.CellValue,
  numFmt: string | undefined,
): DisplayText | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return formatNumber(value, numFmt);
  }
  if (typeof value === 'string') {
    return { text: value };
  }
  if (typeof value === 'boolean') {
    return { text: value ? 'TRUE' : 'FALSE' };
  }
  if (value instanceof Date) {
    return { text: value.toISOString().slice(0, 10) };
  }
  if ('error' in value) {
    // A formula error (`#DIV/0!`, `#REF!`, `#N/A`, ...) is what the formula's author sees, not a
    // reported figure — indexing it as evidence text would let a broken formula's error string
    // stand in for a real quote. Treated the same as a blank cell: no element emitted for it.
    return undefined;
  }
  if ('richText' in value) {
    return { text: value.richText.map((run) => run.text).join('') };
  }
  if ('formula' in value || 'sharedFormula' in value) {
    return value.result === undefined ? undefined : displayTextForValue(value.result, numFmt);
  }
  if ('hyperlink' in value) {
    return value.text === undefined ? undefined : { text: value.text };
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
    throw new MalformedXlsxException(`Cell address '${cell}' is not in A1 notation`);
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

function decodeMergeRange(range: string): MergeBounds {
  const [topLeft, bottomRight] = range.split(':');
  const start = parseCellAddress(topLeft);
  const end = parseCellAddress(bottomRight ?? topLeft);
  return {
    top: start.row,
    left: columnIndex(start.column),
    bottom: end.row,
    right: columnIndex(end.column),
  };
}

/**
 * Fails CLOSED, as a capacity limit: a merge range whose bounding box covers more than
 * `MAX_MERGE_RANGE_CELLS` cells is rejected before any caller loops over it, because the cost of
 * the rectangle is the rectangle itself and nothing in `assertSafeArchive`'s declared sizes sees
 * it. A merge range states its own extent and cannot state it falsely, so an oversized one is a
 * workbook shaped past what this parser carries, not an archive lying about itself.
 */
function assertWithinMergeRangeBudget(range: string, bounds: MergeBounds): void {
  const cellCount = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
  if (cellCount > MAX_MERGE_RANGE_CELLS) {
    throw new MalformedXlsxException(
      `Merge range "${range}" covers ${cellCount} cells, exceeding the ${MAX_MERGE_RANGE_CELLS} ` +
        'this parser supports — split the workbook or trim the merged banner to a smaller range',
    );
  }
}

/**
 * Fails CLOSED, as a capacity limit: rejects the workbook once the running count of emitted
 * elements exceeds `MAX_TOTAL_EMITTED_ELEMENTS`, whether the volume came from ordinary non-empty
 * cells or from merge-range expansion. An element count is what a workbook is, so a workbook past
 * this is too large for this parser rather than hostile to it.
 */
function assertWithinEmittedElementBudget(elementCount: number): void {
  if (elementCount > MAX_TOTAL_EMITTED_ELEMENTS) {
    throw new MalformedXlsxException(
      `Workbook emits more than ${MAX_TOTAL_EMITTED_ELEMENTS} cells, exceeding the size this ` +
        'parser supports — split the workbook or trim it to a smaller extract',
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
    // Three passes, each completing before `workbook.xlsx.load()` is reached, ordered cheapest
    // first and capacity before hostility. This parser's declared-size caps sit below
    // `assertSafeArchive`'s, and both would refuse the same overflow, so reading the capacity
    // limit first is what keeps an honestly oversized workbook from being called an attack. The
    // inflate pass runs last because it is the only one that decompresses: an entry that cleared
    // the declared caps and still overflows here declared one size and carries another, and that
    // contradiction — the one thing an archive cannot be honest about — is the whole warrant for
    // `HostileArchiveException`.
    assertWithinDeclaredXlsxSizeBudget(zip);
    assertSafeArchive(zip);
    await assertArchiveInflatesWithinBudget(
      zip,
      createInflateBudget(MAX_XLSX_ARCHIVE_INFLATED_BYTES),
    );

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
    const reducedFidelityReasons: string[] = [];
    // Keyed by the format string so one unreproducible format spanning a whole column states
    // itself once, rather than once per cell that carries it.
    const unsupportedNumberFormats = new Set<string>();

    // Fails CLOSED into this module's own input contract: every value read below comes from the
    // uploaded file — cell values, number formats, merge ranges, sheet geometry — and reaches
    // JavaScript and exceljs APIs that have domains of their own. A failure raised by one of them
    // is a statement about the file, so it surfaces as the 400 this module raises for bad input
    // rather than reaching the caller as an unhandled error. This module's own guards
    // (`HostileArchiveException`, `MalformedXlsxException`) already carry their status and pass
    // through untouched.
    try {
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

            const display = displayTextForValue(cell.value, cell.numFmt);
            if (display === undefined || display.text.trim() === '') {
              return;
            }
            if (display.unsupportedFormat !== undefined) {
              unsupportedNumberFormats.add(display.unsupportedFormat);
            }

            const locator: XlsxCellLocator = {
              kind: 'xlsx-cell',
              sheetName: worksheet.name,
              cell: cell.address,
              extractorVersion: EXTRACTOR_VERSION,
            };

            elements.push({
              text: sanitizeEvidenceText(display.text),
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
          let bounds: MergeBounds;
          try {
            bounds = decodeMergeRange(mergeRange);
          } catch {
            // A malformed merge-range address is a defect in this one declared range, not the whole
            // workbook — every other merge, and every ordinary cell already emitted above, is still
            // real data worth keeping. Matches this module's prevailing fail-open-with-a-reason
            // posture rather than aborting the entire sheet over one bad range.
            reducedFidelityReasons.push(
              `Sheet '${worksheet.name}': merge range "${mergeRange}" has a malformed cell address ` +
                'and was skipped',
            );
            continue;
          }
          assertWithinMergeRangeBudget(mergeRange, bounds);

          const { top, left, bottom, right } = bounds;
          const masterCell = worksheet.getCell(top, left);
          const masterDisplay = displayTextForValue(masterCell.value, masterCell.numFmt);
          if (masterDisplay === undefined || masterDisplay.text.trim() === '') {
            continue;
          }
          if (masterDisplay.unsupportedFormat !== undefined) {
            unsupportedNumberFormats.add(masterDisplay.unsupportedFormat);
          }
          const sanitizedText = sanitizeEvidenceText(masterDisplay.text);

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
                mergeCovered: true,
              });
              assertWithinEmittedElementBudget(elements.length);
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof BaseException) {
        throw error;
      }
      throw new MalformedXlsxException('Could not read the workbook contents', error);
    }

    for (const numFmt of unsupportedNumberFormats) {
      reducedFidelityReasons.push(
        `Number format '${numFmt}' carries tokens this parser does not reproduce; cells using it ` +
          'show their unformatted value',
      );
    }

    return {
      elements,
      extractorVersion: EXTRACTOR_VERSION,
      reducedFidelityReasons:
        reducedFidelityReasons.length > 0 ? reducedFidelityReasons : undefined,
    };
  }
}
