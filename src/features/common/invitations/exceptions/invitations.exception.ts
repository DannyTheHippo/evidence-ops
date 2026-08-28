import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

/** Fails CLOSED: `InvitationsService.mint` throws this rather than minting a token for an email
 *  that already has an account — email is globally unique, so the invitation could never be
 *  redeemed, and registration would refuse it anyway (see `EmailAlreadyRegisteredException`). */
export class InvitationEmailAlreadyRegisteredException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

/** Thrown by `revoke` and `resend` for a malformed id, a missing row, a foreign-tenant row, or a
 *  row already accepted or revoked — the same message and status in every case, so a cross-tenant
 *  id reads identically to one that was never minted. */
export class InvitationNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/** Thrown by the preview endpoint for an unknown, expired, revoked, or already-accepted token —
 *  the same message and status in every case, mirroring `InvalidInvitationException` on the
 *  registration path this preview precedes. An unauthenticated endpoint that takes a token as its
 *  only credential must not let those four cases differ in status, message, or shape; doing so
 *  would turn the endpoint into an oracle for which tokens exist. */
export class InvitationInvalidException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}
