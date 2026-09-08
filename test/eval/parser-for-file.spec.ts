import { parserForFile } from '../../eval/parser-for-file';
import { CsvParser } from '../../src/features/evidence/ingestion/parsers/csv.parser';
import { DocxParser } from '../../src/features/evidence/ingestion/parsers/docx.parser';
import { HtmlParser } from '../../src/features/evidence/ingestion/parsers/html.parser';
import { PdfParser } from '../../src/features/evidence/ingestion/parsers/pdf.parser';
import { XlsxParser } from '../../src/features/evidence/ingestion/parsers/xlsx.parser';

describe('parserForFile', () => {
  it('should return a PdfParser for a .pdf filename', () => {
    expect(parserForFile('valuation-memo.pdf')).toBeInstanceOf(PdfParser);
  });

  it('should return a DocxParser for a .docx filename', () => {
    expect(parserForFile('lease-summary.docx')).toBeInstanceOf(DocxParser);
  });

  it('should return a CsvParser for a .csv filename', () => {
    expect(parserForFile('export.csv')).toBeInstanceOf(CsvParser);
  });

  it('should return an XlsxParser for a .xlsx filename', () => {
    expect(parserForFile('comps.xlsx')).toBeInstanceOf(XlsxParser);
  });

  it('should return an HtmlParser for a .htm filename', () => {
    expect(parserForFile('primary-doc.htm')).toBeInstanceOf(HtmlParser);
  });

  it('should return an HtmlParser for a .html filename', () => {
    expect(parserForFile('primary-doc.html')).toBeInstanceOf(HtmlParser);
  });

  it('should throw for an extension none of these parsers claims', () => {
    expect(() => parserForFile('archive.zip')).toThrow(/no parser for 'archive\.zip'/);
  });
});
