import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class ApprovalNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/** Thrown by `ApprovalsService.decide` when the row is not `pending` — a decision is a
 *  permission boundary, not an update: it cannot be re-applied to a row already decided. */
export class ApprovalAlreadyDecidedException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

/** Thrown by `ApprovalsService.decide` when the decision was persisted but
 *  `WorkflowEngine.signal()` failed — see `decide()`'s own doc comment for why this must surface
 *  rather than be swallowed. 502: the failure is in a downstream dependency (the workflow engine),
 *  not in this request. */
export class ApprovalSignalFailedException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_GATEWAY, cause);
  }
}
