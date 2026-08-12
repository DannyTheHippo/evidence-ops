import type { XlsxCellLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { MalformedCsvException } from '../exceptions/ingestion.exception';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

// Bump whenever a change here could shift the cell coordinates a stored citation points at.
const EXTRACTOR_VERSION = 'csv-rfc4180-1';

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
      let text = content.toString('utf-8');
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }

      const rows = this.tokenize(text);

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

      return { elements, extractorVersion: EXTRACTOR_VERSION };
    });
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
   */
  private tokenize(text: string): string[][] {
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

      if (state === 'closed' && char !== this.delimiter && char !== '\r' && char !== '\n') {
        throw new MalformedCsvException(
          `Unexpected character after a closing quote at offset ${i}`,
        );
      }

      if (char === '"' && state === 'start') {
        state = 'quoted';
        i += 1;
      } else if (char === '"' && state === 'unquoted') {
        throw new MalformedCsvException(`Unexpected quote inside an unquoted field at offset ${i}`);
      } else if (char === this.delimiter) {
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
