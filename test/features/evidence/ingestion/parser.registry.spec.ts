import { UnsupportedMimeTypeException } from '../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import type {
  DocumentParser,
  ParsedDocument,
} from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';

function buildStubParser(supports: readonly string[]): DocumentParser {
  return {
    supports,
    parse: jest.fn<Promise<ParsedDocument>, [Buffer]>().mockResolvedValue({
      elements: [],
      extractorVersion: 'stub-1',
    }),
  };
}

describe('ParserRegistry', () => {
  it('should resolve a MIME type to the parser that declares it in `supports`', () => {
    const pdfParser = buildStubParser(['application/pdf']);
    const docxParser = buildStubParser([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    const registry = new ParserRegistry([pdfParser, docxParser]);

    expect(registry.resolve('application/pdf')).toBe(pdfParser);
    expect(
      registry.resolve('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(docxParser);
  });

  it('should throw UnsupportedMimeTypeException for a MIME type no parser declares', () => {
    const registry = new ParserRegistry([buildStubParser(['application/pdf'])]);

    expect(() => registry.resolve('text/csv')).toThrow(UnsupportedMimeTypeException);
  });

  it('should require an exact match, not a prefix match', () => {
    const registry = new ParserRegistry([buildStubParser(['application/pdf'])]);

    expect(() => registry.resolve('application/pdf-extended')).toThrow(
      UnsupportedMimeTypeException,
    );
  });

  it('should let a later parser in the list win when two parsers declare the same MIME type', () => {
    const firstParser = buildStubParser(['application/pdf']);
    const secondParser = buildStubParser(['application/pdf']);
    const registry = new ParserRegistry([firstParser, secondParser]);

    expect(registry.resolve('application/pdf')).toBe(secondParser);
  });
});
