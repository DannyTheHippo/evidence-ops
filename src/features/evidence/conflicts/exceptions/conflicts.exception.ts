import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class ConflictNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/** Thrown by `ConflictsService.loadConflictForResolution` when the conflict is not `open` (already
 * decided by an earlier resolution attempt) or the caller's proposed `winningFactId` is not one of
 * the conflict's own `factIds` — both are fail-closed guards against asking a human to approve a
 * proposal that can't be honored. */
export class InvalidConflictResolutionException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}
