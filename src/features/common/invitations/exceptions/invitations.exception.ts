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
