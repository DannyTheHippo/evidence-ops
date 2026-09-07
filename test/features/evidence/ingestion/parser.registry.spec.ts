import { SOURCE_KIND_TO_MIME_TYPE } from '../../../../src/features/evidence/documents/documents.constant';
import { UnsupportedMimeTypeException } from '../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import { buildDocumentParsers } from '../../../../src/features/evidence/ingestion/ingestion.module';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import { HtmlParser } from '../../../../src/features/evidence/ingestion/parsers/html.parser';
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

  describe('the real registration', () => {
    /**
     * The cases above use stubs, so none of them can catch the failure that actually matters: an
     * upload kind the MIME gate accepts whose canonical type no registered parser declares. That
     * combination is silent — `resolveUploadKind` returns a kind, the upload succeeds, and
     * ingestion throws `UnsupportedMimeTypeException` later, out of band. These two cases run
     * against `buildDocumentParsers()`, the same list `IngestionModule` provides.
     */
    const registry = new ParserRegistry(buildDocumentParsers());

    it.each(Object.entries(SOURCE_KIND_TO_MIME_TYPE))(
      'should route the canonical MIME for source kind %s to a registered parser',
      (_kind, mimeType) => {
        expect(() => registry.resolve(mimeType)).not.toThrow();
      },
    );

    it('should register no MIME type that no upload kind can produce', () => {
      const canonical = new Set(Object.values(SOURCE_KIND_TO_MIME_TYPE));
      const registered = buildDocumentParsers().flatMap((parser) => [...parser.supports]);

      expect(registered.filter((mimeType) => !canonical.has(mimeType))).toEqual([]);
    });

    it('should route text/html to HtmlParser', () => {
      expect(registry.resolve('text/html')).toBeInstanceOf(HtmlParser);
    });
  });
});
