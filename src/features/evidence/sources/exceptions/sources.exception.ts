import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class SourceNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/**
 * Raised when `SourcesService.create` hits the unique `{tenantId, name}` index
 * (`migrations/0001-baseline.ts`) — the application-layer surface for the same
 * content-addressing-style race `DocumentVersion`'s unique index backstops.
 */
export class SourceNameConflictException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

/**
 * `EvidenceSubmissionService.submit`'s base64 shape gate: the payload is too large to decode
 * (over `SUBMIT_EVIDENCE_MAX_BASE64_CHARS`), not well-formed base64 (illegal charset, wrong
 * padding length), or decodes to zero bytes. Distinct status from the "too large" case below —
 * this one is about the payload's shape, not its size.
 */
export class InvalidBase64ContentException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/**
 * `EvidenceSubmissionService.submit`'s size gate, checked before anything else runs (fails
 * CLOSED against a payload proportional to `SUBMIT_EVIDENCE_MAX_BASE64_CHARS` being decoded,
 * hashed, or stored) — a 413, distinct from `InvalidBase64ContentException`'s 400.
 */
export class SubmissionTooLargeException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.PAYLOAD_TOO_LARGE, cause);
  }
}

/**
 * Raised when the `{tenantId, name}` row `EvidenceSubmissionService.submit` resolved for an
 * MCP submission already exists with a `kind` other than `'mcp-submit'` — the same name is
 * claimed by a REST-created source, so the submission cannot silently attach to it.
 */
export class SubmitSourceKindConflictException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}
