import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class DocumentVersionNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

// A route param naming a metric outside `METRIC_IDS` — not a stored resource that could be
// missing, so this is a malformed request (400), not a 404.
export class UnknownMetricException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

// A tenant-metric route param that does not match the ontology's own lowercase snake_case
// naming convention — not a stored resource that could be missing, so this is a malformed
// request (400), not a 404.
export class InvalidMetricIdException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}
