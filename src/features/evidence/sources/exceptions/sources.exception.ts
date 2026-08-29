import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class SourceNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/**
 * Raised when `SourcesService.create` hits the unique `{tenantId, name}` index
 * (`migrations/0001-baseline.ts`) — the application-layer surface for the same
 * content-addressing-style race `DocumentVersion`'s unique index backstops.
 */
export class SourceNameConflictException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}
