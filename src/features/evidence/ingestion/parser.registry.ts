import { Inject, Injectable } from '@nestjs/common';
import { UnsupportedMimeTypeException } from './exceptions/ingestion.exception';
import type { DocumentParser } from './parsers/parsed-element.type';

export const DOCUMENT_PARSERS = Symbol('DOCUMENT_PARSERS');

/**
 * Resolves a MIME type to the parser that claims it. Built from each parser's own `supports`
 * list rather than a hardcoded switch, so a new parser only has to be added to the
 * `DOCUMENT_PARSERS` provider in `IngestionModule` to be dispatched to.
 */
@Injectable()
export class ParserRegistry {
  private readonly parserByMimeType: ReadonlyMap<string, DocumentParser>;

  constructor(@Inject(DOCUMENT_PARSERS) parsers: readonly DocumentParser[]) {
    const byMimeType = new Map<string, DocumentParser>();
    for (const parser of parsers) {
      for (const mimeType of parser.supports) {
        byMimeType.set(mimeType, parser);
      }
    }
    this.parserByMimeType = byMimeType;
  }

  /** Exact match only — `supports` entries are full MIME types, not prefixes. */
  resolve(mimeType: string): DocumentParser {
    const parser = this.parserByMimeType.get(mimeType);
    if (!parser) {
      throw new UnsupportedMimeTypeException(`No parser registered for content type '${mimeType}'`);
    }
    return parser;
  }
}
