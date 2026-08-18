import { HttpStatus } from '@nestjs/common';
import { BaseException } from './base.exception';

/**
 * Thrown by `acquireStreamSlot` (`stream-session.util.ts`) when a tenant or user is already at
 * its open-SSE-stream cap. Cross-feature — all three SSE controllers (`qa`, `workflow-runs`,
 * `documents`) throw it — so it lives here rather than in a single feature's `exceptions/` dir.
 */
export class StreamConnectionLimitExceededException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.TOO_MANY_REQUESTS, cause);
  }
}
