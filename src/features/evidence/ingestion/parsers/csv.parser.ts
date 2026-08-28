import type { XlsxCellLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { decodeTextBuffer, encodingFidelityReasons } from '../decode-text-buffer';
import { MalformedCsvException } from '../exceptions/ingestion.exception';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

// Bump whenever a change here could shift the cell coordinates a stored citation points at.
// Encoding detection (`decodeTextBuffer`) and delimiter sniffing (`sniffDelimiter`) can each move
// a coordinate on their own: a wrong encoding shifts every cell's text, and a semicolon-delimited
// row that gets sniffed splits into columns a single-field row would not.
const EXTRACTOR_VERSION = 'csv-rfc4180-3';

// The only delimiter this sniff ever swaps the constructor's own default for — never applied when
// the constructor delimiter is a tab, since TSV's separator is unambiguous from its MIME type.
const SNIFFABLE_DELIMITER = ';';

// How many leading non-empty lines the sniff samples. Large enough to reject a false positive from
// one stray semicolon in prose, small enough to stay cheap on a huge file.
const DELIMITER_SNIFF_SAMPLE_LINES = 5;

function countOutsideQuotedSpans(line: string, char: string): number {
  // Quoted-span removal here is a sniff, not a parse — good enough to keep a comma or semicolon
  // inside a quoted field from inflating either candidate's count, without running the full
  // character-scanning tokenizer twice.
  return line.replace(/"(?:[^"]|"")*"/g, '').split(char).length - 1;
}

// Every element this parser emits carries this constant in place of a real sheet name — a parser
// only ever receives a Buffer, never the original filename, so there is no name to derive one
// from. Reusing the xlsx-cell locator kind (rather than inventing a csv-specific one) is
// deliberate: it buys the existing spreadsheet-aware chunker routing, deterministic fact
// extraction, and both `formatLocator` switches unchanged (see chunker.ts's `kind === 'xlsx-cell'`
// dispatch).
const CSV_SHEET_NAME = 'CSV';

/** Field-scan state: `start` accepts a quote (open a quoted field); `unquoted` has already
 * consumed a bare character, so a quote here is malformed, not a literal; `quoted` is inside an
 * open quote; `closed` is just past a quote's closing `"` and only a delimiter/newline/EOF may
 * follow it. */
type FieldState = 'start' | 'unquoted' | 'quoted' | 'closed';

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Hand-rolled RFC 4180 rather than `fast-csv`: that library takes a stream, not a buffer, and
 * coerces values through timezone-sensitive date parsing — both would make the content-addressed
 * chunk id a CSV produces depend on the machine that ingested it.
 *
 * One instance serves both CSV and TSV; the field delimiter is the only difference between the
 * two formats, so it is a constructor argument rather than a duplicated class.
 */
export class CsvParser implements DocumentParser {
  constructor(
    private readonly delimiter: string,
    readonly supports: readonly string[],
  ) {}

  // Not `async`: parsing here is entirely synchronous, and `async` with no `await` inside trips
  // `@typescript-eslint/require-await`. `Promise.resolve().then(...)` still turns a synchronous
  // throw from `tokenize` into a promise rejection, matching `DocumentParser.parse`'s contract.
  parse(content: Buffer): Promise<ParsedDocument> {
    return Promise.resolve().then(() => {
      // `decodeTextBuffer` strips any BOM and resolves the encoding from the bytes themselves —
      // a spreadsheet's "CSV UTF-8" export can carry a UTF-8 BOM over a cp1252 body. This parser
      // never touches the raw buffer itself.
      const { text, encoding } = decodeTextBuffer(content);
      const delimiter = this.delimiter === ',' ? this.sniffDelimiter(text) : this.delimiter;

      const rows = this.tokenize(text, delimiter);

      const elements: ParsedElement[] = [];
      rows.forEach((row, rowIndex) => {
        row.forEach((value, columnIndex) => {
          if (value.trim() === '') {
            return;
          }

          const locator: XlsxCellLocator = {
            kind: 'xlsx-cell',
            sheetName: CSV_SHEET_NAME,
            cell: `${columnLetter(columnIndex)}${rowIndex + 1}`,
            extractorVersion: EXTRACTOR_VERSION,
          };

          elements.push({
            text: sanitizeEvidenceText(value),
            locator,
            headingPath: [],
          });
        });
      });

      return {
        elements,
        extractorVersion: EXTRACTOR_VERSION,
        reducedFidelityReasons: encodingFidelityReasons(encoding),
      };
    });
  }

  /**
   * Only ever consulted when the constructor delimiter is `,` — a European export that actually
   * uses `;` reads as `text/csv`, never as a distinct MIME `resolveUploadKind` could route to a
   * differently-configured instance, so the ambiguity has to be resolved from content instead.
   *
   * Semicolon wins only when every sampled line carries the exact same nonzero semicolon count and
   * that count strictly exceeds the highest comma count among the same lines — consistency, not a
   * bare majority vote, so a single stray semicolon in ordinary prose ("Site A; 5.25% cap rate")
   * cannot flip an otherwise comma-delimited file. A tie, an inconsistent semicolon count across
   * rows, or a comma count that already matches or beats it all fall back to the constructor's own
   * default.
   */
  private sniffDelimiter(text: string): string {
    const sampleLines = text
      .split(/\r\n|\r|\n/)
      .filter((line) => line.length > 0)
      .slice(0, DELIMITER_SNIFF_SAMPLE_LINES);
    if (sampleLines.length === 0) {
      return this.delimiter;
    }

    const semicolonCounts = sampleLines.map((line) =>
      countOutsideQuotedSpans(line, SNIFFABLE_DELIMITER),
    );
    const maxCommaCount = Math.max(
      ...sampleLines.map((line) => countOutsideQuotedSpans(line, this.delimiter)),
    );

    const [firstSemicolonCount] = semicolonCounts;
    const consistentSemicolons =
      firstSemicolonCount > 0 && semicolonCounts.every((count) => count === firstSemicolonCount);

    return consistentSemicolons && firstSemicolonCount > maxCommaCount
      ? SNIFFABLE_DELIMITER
      : this.delimiter;
  }

  /**
   * Character-scanning state machine rather than a line-then-field split: RFC 4180 permits a
   * quoted field to contain a literal CR or LF, so splitting on newlines before fields would cut
   * a quoted multi-line field in half.
   *
   * Fails CLOSED on anything the grammar does not allow — a quote inside an already-started
   * unquoted field, a character following a closed quote other than a delimiter/newline, or a
   * quoted field still open at EOF. A guessed row is worse than no row for a citation-backed
   * answer, so none of these are repaired leniently.
   *
   * `delimiter` is the sniffed/constructor-default field separator for this call, not necessarily
   * `this.delimiter` — see `parse`'s `sniffDelimiter` call.
   */
  private tokenize(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let state: FieldState = 'start';

    const endField = (): void => {
      row.push(field);
      field = '';
      state = 'start';
    };
    const endRow = (): void => {
      endField();
      rows.push(row);
      row = [];
    };

    let i = 0;
    while (i < text.length) {
      const char = text[i];

      if (state === 'quoted') {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            state = 'closed';
            i += 1;
          }
        } else {
          field += char;
          i += 1;
        }
        continue;
      }

      if (state === 'closed' && char !== delimiter && char !== '\r' && char !== '\n') {
        throw new MalformedCsvException(
          `Unexpected character after a closing quote at offset ${i}`,
        );
      }

      if (char === '"' && state === 'start') {
        state = 'quoted';
        i += 1;
      } else if (char === '"' && state === 'unquoted') {
        throw new MalformedCsvException(`Unexpected quote inside an unquoted field at offset ${i}`);
      } else if (char === delimiter) {
        endField();
        i += 1;
      } else if (char === '\r' || char === '\n') {
        endRow();
        i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
      } else {
        field += char;
        state = 'unquoted';
        i += 1;
      }
    }

    if (state === 'quoted') {
      throw new MalformedCsvException('Unterminated quoted field');
    }
    if (field.length > 0 || row.length > 0) {
      endRow();
    }

    return rows;
  }
}
