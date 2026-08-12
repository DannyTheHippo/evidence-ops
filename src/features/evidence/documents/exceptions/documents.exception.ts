import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class DocumentNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

export class DocumentVersionNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

export class UnsupportedContentTypeException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.UNSUPPORTED_MEDIA_TYPE, cause);
  }
}

export class MissingFileException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}
