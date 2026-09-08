import { CsvParser } from '../src/features/evidence/ingestion/parsers/csv.parser';
import { DocxParser } from '../src/features/evidence/ingestion/parsers/docx.parser';
import { HtmlParser } from '../src/features/evidence/ingestion/parsers/html.parser';
import type { DocumentParser } from '../src/features/evidence/ingestion/parsers/parsed-element.type';
import { PdfParser } from '../src/features/evidence/ingestion/parsers/pdf.parser';
import { XlsxParser } from '../src/features/evidence/ingestion/parsers/xlsx.parser';

/**
 * Picks the ingestion parser for a corpus-relative filename by extension — the dispatch
 * `resolve-locator.ts` used to keep inline, pulled out here for its second caller, the public-corpus
 * sizing probe (`scripts/public-corpus/size-corpus.ts`), which parses every manifest file with no
 * other way to know which parser a `.htm` filing needs. Throws on an extension none of these parsers
 * claims rather than guessing a default — a wrong parser here would misattribute a document's whole
 * citation base to the wrong extractor.
 */
export function parserForFile(filename: string): DocumentParser {
  if (filename.endsWith('.pdf')) {
    return new PdfParser();
  }
  if (filename.endsWith('.docx')) {
    return new DocxParser();
  }
  if (filename.endsWith('.csv')) {
    return new CsvParser(',', ['text/csv']);
  }
  if (filename.endsWith('.xlsx')) {
    return new XlsxParser();
  }
  if (filename.endsWith('.htm') || filename.endsWith('.html')) {
    return new HtmlParser();
  }
  throw new Error(`parserForFile: no parser for '${filename}'`);
}
