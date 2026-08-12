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

// Distinct from `UnsupportedContentTypeException`: that one is for a MIME type the server does
// not recognize at all (415, the media type itself is the problem). This is for a MIME type
// `resolveUploadKind` *does* recognize as ambiguous (`AMBIGUOUS_UPLOAD_MIME_TYPES`) but could not
// resolve because the filename's extension is not on the allowlist — the request itself is
// malformed (a filename/content-type combination the client should not have sent), which is a 400.
export class UnresolvableContentTypeException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

export class MissingFileException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}
