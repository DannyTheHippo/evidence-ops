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
