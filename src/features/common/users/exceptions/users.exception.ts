import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class UserNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/** `UsersService.changeRole`/`remove` throw this from inside their guarded transaction, after its
 *  own count query confirms zero admins would remain — that transaction never commits, so the
 *  tenant's admin count stays exactly what it was immediately before this call ran. A tenant can
 *  reach this state only by this call's own count query observing it, never by a process death or
 *  a losing write conflict, both of which abort the transaction without this exception ever being
 *  thrown or reaching this point. */
export class LastAdminException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

/** `UsersService`'s admin-count guard throws this when a tenant has no registry row to
 *  materialize its write conflict against. Every tenant is created with one before its first user
 *  exists, so a missing row here signals that invariant has broken rather than a normal refusal —
 *  the guarded transaction never commits when this is thrown. */
export class AdminGuardUnavailableException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR, cause);
  }
}
