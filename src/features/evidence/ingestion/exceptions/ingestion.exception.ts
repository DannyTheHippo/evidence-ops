import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

/** Input gate for `ParserRegistry.resolve` — fails CLOSED: a MIME type with no exact-match
 * parser is rejected rather than falling back to a best-guess parser. */
export class UnsupportedMimeTypeException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.UNSUPPORTED_MEDIA_TYPE, cause);
  }
}

export class DocumentVersionNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/**
 * Thrown by `IngestionService.ingestVersion` when the caller's abort signal fires mid-attempt —
 * the Temporal activity's own cancellation, raised after a heartbeat timeout or a workflow-level
 * cancellation (`src/worker/activities.ts`).
 *
 * Fails CLOSED toward a recorded failure: it exists so an abandoned attempt reaches the catch that
 * writes `ingestionStatus: 'failed'`, rather than leaving the version `pending` with a live lease
 * and no diagnosis. Retryable — an attempt cut short says nothing about whether the next one over
 * the same bytes can succeed, so it is deliberately absent from
 * `INGEST_NON_RETRYABLE_ERROR_TYPES` (`src/workflows/ingest-retry-policy.ts`).
 */
export class IngestionAbandonedException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.SERVICE_UNAVAILABLE, cause);
  }
}

/** Thrown by `CsvParser` — fails CLOSED: a CSV/TSV buffer that does not parse as valid RFC 4180
 * is rejected outright rather than emitting a guessed row. */
export class MalformedCsvException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/** Input gate for `PptxParser.parse` — fails CLOSED: a missing part, a dangling slide
 * relationship, or malformed XML rejects the whole archive rather than returning partial slide
 * text. */
export class MalformedPptxException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/**
 * Thrown by `parseEmailMessage` (`parsers/email-mime.ts`) when a message's own structure does not
 * hold together: no header block at all, a `multipart` content type declaring no boundary, or a
 * boundary that opens and never closes.
 *
 * Fails CLOSED, and exists so a malformed or truncated email reaches a visible terminal state
 * (`ingestionStatus: 'failed'` with this message as its reason) instead of parsing to zero
 * elements and presenting as an empty-but-successful ingest.
 *
 * The counterpart to `HostileEmailException`: this one is about a message that cannot be read, that
 * one about a message that is read fine and asks for more than the limits allow.
 */
export class MalformedEmailException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/**
 * Thrown by `parseEmailMessage` (`parsers/email-mime.ts`) when a well-formed message exceeds one of
 * the container limits that bound what unwrapping it can cost: part count, multipart nesting depth,
 * per-attachment decoded bytes, or total decoded attachment bytes.
 *
 * Fails CLOSED on the whole message, never per-part: a message that crosses a limit has already
 * shown that its declared shape is not one this product handles, and unwrapping the prefix that
 * fits would hand a caller a partial set of attachments it has no way to know is partial.
 *
 * Mirrors `HostileArchiveException`'s split of the same problem for zip containers, and is a
 * separate class rather than a reuse of it because a caller distinguishing "this archive lied" from
 * "this message asked for too much" needs the two to be distinguishable.
 */
export class HostileEmailException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}
