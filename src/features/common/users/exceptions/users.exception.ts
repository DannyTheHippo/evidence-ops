import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class UserNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/** `UsersService.changeRole`/`remove` throw this instead of letting a write take a tenant's admin
 *  count to zero — a tenant in that state has no path back short of direct database access. The
 *  guard fails closed only within a single request: it cannot see a process death between its
 *  own write and its own compensating check, so that narrow window can still leave the count at
 *  zero with no exception ever thrown. */
export class LastAdminException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

/** `UsersService.remove`'s compensating insert — restoring a row whose removal was refused —
 *  bypasses Mongoose entirely, so a failure here is a raw driver error, most likely the globally
 *  unique `email` index rejecting a registration that claimed the freed address inside the
 *  delete-then-restore window. The admin row stays deleted either way; this exists so that
 *  failure carries a message an operator can act on and its `cause` instead of collapsing to a
 *  generic 500. */
export class UserRestoreFailedException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR, cause);
  }
}
