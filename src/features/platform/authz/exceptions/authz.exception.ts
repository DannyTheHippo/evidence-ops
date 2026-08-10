import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

/** Thrown by `ToolExecutorService.registerTool` — a registration-time programming error (two
 * tools registered under the same name), not a runtime call outcome, so it throws rather than
 * returning a `ToolExecutionResult` refusal. */
export class ToolAlreadyRegisteredException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR, cause);
  }
}
