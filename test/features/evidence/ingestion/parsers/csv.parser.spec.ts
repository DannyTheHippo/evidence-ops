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
          extractorVersion: 'csv-rfc4180-1',
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

      expect(result.extractorVersion).toBe('csv-rfc4180-1');
      expect(result.elements.length).toBeGreaterThan(0);
      for (const element of result.elements) {
        expect(element.locator.extractorVersion).toBe('csv-rfc4180-1');
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
});
