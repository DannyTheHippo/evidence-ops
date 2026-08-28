import type { XlsxCellLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { MalformedCsvException } from '../../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import { CsvParser } from '../../../../../src/features/evidence/ingestion/parsers/csv.parser';
import { sanitizeEvidenceText } from '../../../../../src/features/evidence/ingestion/sanitize-evidence-text';

function findCellElement(
  elements: readonly { locator: { kind: string }; text: string }[],
  cell: string,
) {
  return elements.find(
    (element) =>
      element.locator.kind === 'xlsx-cell' && (element.locator as XlsxCellLocator).cell === cell,
  );
}

describe('CsvParser', () => {
  describe('parse — comma-delimited', () => {
    let parser: CsvParser;

    beforeEach(() => {
      parser = new CsvParser(',', ['text/csv']);
    });

    it('should locate a value in the second column of the second row at cell B2, under a constant CSV sheet name', async () => {
      const buffer = Buffer.from('Name,Amount\nAcme,100\n');

      const result = await parser.parse(buffer);

      const b2 = findCellElement(result.elements, 'B2');
      expect(b2).toEqual({
        text: '100',
        locator: {
          kind: 'xlsx-cell',
          sheetName: 'CSV',
          cell: 'B2',
          extractorVersion: 'csv-rfc4180-3',
        },
        headingPath: [],
      });
    });

    it('should keep a delimiter that appears inside a quoted field as part of that one field', async () => {
      const buffer = Buffer.from('"Acme, Inc.",100\n');

      const result = await parser.parse(buffer);

      const a1 = findCellElement(result.elements, 'A1');
      expect(a1?.text).toBe(sanitizeEvidenceText('Acme, Inc.'));
      expect(findCellElement(result.elements, 'B1')?.text).toBe('100');
    });

    it('should unescape a doubled quote inside a quoted field to a single literal quote', async () => {
      const buffer = Buffer.from('"he said ""hi"""\n');

      const result = await parser.parse(buffer);

      expect(findCellElement(result.elements, 'A1')?.text).toBe(
        sanitizeEvidenceText('he said "hi"'),
      );
    });

    it('should treat CRLF the same as LF as a row terminator', async () => {
      const buffer = Buffer.from('a,b\r\nc,d\r\n');

      const result = await parser.parse(buffer);

      expect(findCellElement(result.elements, 'A1')?.text).toBe('a');
      expect(findCellElement(result.elements, 'A2')?.text).toBe('c');
      // A trailing CRLF must not produce a phantom third row.
      expect(findCellElement(result.elements, 'A3')).toBeUndefined();
    });

    it('should strip a leading UTF-8 BOM before parsing the first field', async () => {
      const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n')]);

      const result = await parser.parse(buffer);

      expect(findCellElement(result.elements, 'A1')?.text).toBe('a');
    });

    it('should not emit an element for an empty cell between two delimiters', async () => {
      const buffer = Buffer.from('a,,c\n');

      const result = await parser.parse(buffer);

      expect(findCellElement(result.elements, 'A1')?.text).toBe('a');
      expect(findCellElement(result.elements, 'B1')).toBeUndefined();
      expect(findCellElement(result.elements, 'C1')?.text).toBe('c');
    });

    it('should stamp extractorVersion on the document and on every locator', async () => {
      const buffer = Buffer.from('a,b\nc,d\n');

      const result = await parser.parse(buffer);

      expect(result.extractorVersion).toBe('csv-rfc4180-3');
      expect(result.elements.length).toBeGreaterThan(0);
      for (const element of result.elements) {
        expect(element.locator.extractorVersion).toBe('csv-rfc4180-3');
        expect(element.headingPath).toEqual([]);
      }
    });
  });

  describe('parse — tab-delimited (TSV instance)', () => {
    it('should split fields on tab rather than comma', async () => {
      const parser = new CsvParser('\t', ['text/tab-separated-values']);
      const buffer = Buffer.from('Name\tAmount\nAcme, Inc.\t100\n');

      const result = await parser.parse(buffer);

      // The comma here must NOT split the field — this delimiter instance only splits on tab.
      expect(findCellElement(result.elements, 'A2')?.text).toBe('Acme, Inc.');
      expect(findCellElement(result.elements, 'B2')?.text).toBe('100');
    });
  });

  describe('parse — malformed input (fails closed)', () => {
    let parser: CsvParser;

    beforeEach(() => {
      parser = new CsvParser(',', ['text/csv']);
    });

    it('should reject a quoted field that is never closed', async () => {
      const buffer = Buffer.from('"unterminated');

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedCsvException);
    });

    it('should reject a quote appearing inside a field that already started unquoted', async () => {
      const buffer = Buffer.from('ab"cd\n');

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedCsvException);
    });

    it('should reject a character following a closing quote that is not a delimiter or newline', async () => {
      const buffer = Buffer.from('"abc"def\n');

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedCsvException);
    });
  });

  describe('parse — delimiter sniffing (text/csv only)', () => {
    let parser: CsvParser;

    beforeEach(() => {
      parser = new CsvParser(',', ['text/csv']);
    });

    it('should split a semicolon-delimited European export into columns rather than one column per row', async () => {
      const buffer = Buffer.from('Name;Amount\nAcme;100\nBeta;200\n');

      const result = await parser.parse(buffer);

      expect(findCellElement(result.elements, 'A2')?.text).toBe('Acme');
      expect(findCellElement(result.elements, 'B2')?.text).toBe('100');
      expect(findCellElement(result.elements, 'A3')?.text).toBe('Beta');
      expect(findCellElement(result.elements, 'B3')?.text).toBe('200');
    });

    it('should not sniff semicolon on a TSV instance — tab is unambiguous from its own MIME type', async () => {
      const tsvParser = new CsvParser('\t', ['text/tab-separated-values']);
      const buffer = Buffer.from('Name;Notes\tAmount\nAcme;Site\t100\n');

      const result = await tsvParser.parse(buffer);

      // The semicolon stays part of the first field's text — only tab ever splits this instance.
      expect(findCellElement(result.elements, 'A2')?.text).toBe('Acme;Site');
      expect(findCellElement(result.elements, 'B2')?.text).toBe('100');
    });

    it('should not flip to semicolon when only one sampled row carries a stray semicolon — inconsistent count stays comma', async () => {
      const buffer = Buffer.from('Name,Notes\nAcme,Cap rate; 5.25%\nBeta,Cap rate 6.10%\n');

      const result = await parser.parse(buffer);

      // Still comma-delimited: the semicolon is part of B2's own text, not a column boundary.
      expect(findCellElement(result.elements, 'B2')?.text).toBe('Cap rate; 5.25%');
      expect(findCellElement(result.elements, 'C2')).toBeUndefined();
    });

    it('should not flip to semicolon when its count only ties the comma count — comma wins a tie', async () => {
      const buffer = Buffer.from('A,B;C\nD,E;F\n');

      const result = await parser.parse(buffer);

      // Comma still splits the row; the semicolon stays inside the second field.
      expect(findCellElement(result.elements, 'A1')?.text).toBe('A');
      expect(findCellElement(result.elements, 'B1')?.text).toBe('B;C');
    });
  });

  describe('parse — encoding detection', () => {
    it('should decode a windows-1252 CSV, mapping a byte in the 0x80-0x9F range through the cp1252 table', async () => {
      const parser = new CsvParser(',', ['text/csv']);
      // "A,Tenant's Notes" with the windows-1252 right-single-quote byte (0x92) standing in for
      // the apostrophe — not a valid UTF-8 sequence on its own.
      const buffer = Buffer.from([...Buffer.from('A,Tenant'), 0x92, ...Buffer.from('s Notes\n')]);

      const result = await parser.parse(buffer);

      expect(findCellElement(result.elements, 'B1')?.text).toBe('Tenant’s Notes');
      expect(result.reducedFidelityReasons).toEqual([expect.stringContaining('windows-1252')]);
    });

    it('should decode a UTF-16LE CSV carrying its BOM', async () => {
      const parser = new CsvParser(',', ['text/csv']);
      const content = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('Name,Amount\nAcme,100\n', 'utf16le'),
      ]);

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'A2')?.text).toBe('Acme');
      expect(findCellElement(result.elements, 'B2')?.text).toBe('100');
      expect(result.reducedFidelityReasons).toEqual([expect.stringContaining('utf-16le')]);
    });

    it('should decode a windows-1252 CSV behind a UTF-8 BOM exactly as it decodes the same bytes unmarked, flag included', async () => {
      const parser = new CsvParser(',', ['text/csv']);
      // What a spreadsheet's "CSV UTF-8" export produces over a legacy cp1252 body: 0x92 is the
      // right single quote, 0x97 the em-dash. Trusting the BOM would store U+FFFD for both.
      const body = Buffer.from([
        ...Buffer.from('A,Tenant'),
        0x92,
        ...Buffer.from('s Notes '),
        0x97,
        ...Buffer.from(' Q3\n'),
      ]);
      const declared = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);

      const result = await parser.parse(declared);

      expect(findCellElement(result.elements, 'B1')?.text).toBe('Tenant’s Notes — Q3');
      expect(result.reducedFidelityReasons).toEqual([expect.stringContaining('windows-1252')]);
      expect(result).toEqual(await parser.parse(body));
    });

    it('should report no reduced-fidelity reason for a UTF-8 BOM over genuine UTF-8 content', async () => {
      const parser = new CsvParser(',', ['text/csv']);
      const content = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('Name,Notes\nAcme,Tenant’s Notes — Q3\n', 'utf8'),
      ]);

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'B2')?.text).toBe('Tenant’s Notes — Q3');
      expect(result.reducedFidelityReasons).toBeUndefined();
    });

    it('should report no reduced-fidelity reason for an ordinary UTF-8 CSV', async () => {
      const parser = new CsvParser(',', ['text/csv']);
      const buffer = Buffer.from('Name,Amount\nAcme,100\n');

      const result = await parser.parse(buffer);

      expect(result.reducedFidelityReasons).toBeUndefined();
    });
  });
});
