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
