import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class ApiKeyNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/** Fails CLOSED: `ApiKeysService.mint` throws this rather than minting once a user's active key
 *  count reaches the cap, bounding how many live credentials a single compromised account can
 *  accumulate. */
export class ApiKeyLimitExceededException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}
