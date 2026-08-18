import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class EmailAlreadyRegisteredException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

export class InvalidCredentialsException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.UNAUTHORIZED, cause);
  }
}

export class CsrfOriginMismatchException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.FORBIDDEN, cause);
  }
}

/** Fails CLOSED: an unknown, expired, or already-redeemed invitation token never falls back to
 *  provisioning a fresh tenant — a mistyped or stale token silently becoming a new-org signup
 *  would be invisible to the admin who sent it. */
export class InvalidInvitationException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/** Fails CLOSED: an invitation whose email already has an account is refused rather than moving,
 *  merging, or re-tenanting that account — email is globally unique, and relocating a live
 *  account without its owner's consent is exactly the problem invitations were designed to avoid. */
export class InvitationEmailConflictException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}
