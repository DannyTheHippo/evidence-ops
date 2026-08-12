import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

/** Input gate for `ParserRegistry.resolve` — fails CLOSED: a MIME type with no exact-match
 * parser is rejected rather than falling back to a best-guess parser. */
export class UnsupportedMimeTypeException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.UNSUPPORTED_MEDIA_TYPE, cause);
  }
}

export class DocumentVersionNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/** Thrown by `CsvParser` — fails CLOSED: a CSV/TSV buffer that does not parse as valid RFC 4180
 * is rejected outright rather than emitting a guessed row. */
export class MalformedCsvException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/** Input gate for `PptxParser.parse` — fails CLOSED: a missing part, a dangling slide
 * relationship, or malformed XML rejects the whole archive rather than returning partial slide
 * text. */
export class MalformedPptxException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}
