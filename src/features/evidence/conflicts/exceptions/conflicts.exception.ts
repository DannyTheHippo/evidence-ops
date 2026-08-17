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

/** Thrown by `ConflictsService.requestResolution` when a pending `Approval` already exists for the
 * same conflict — a conflict stays `open` for its whole 24-hour approval wait, so without this
 * guard a second call starts a second `resolveConflict` execution and a second pending row for the
 * same disagreement, each independently approvable, and two approvals naming different
 * `winningFactId`s could both reach `recordResolution`. */
export class ConflictResolutionAlreadyPendingException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}
