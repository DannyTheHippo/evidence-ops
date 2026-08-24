import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../../shared/exceptions/base.exception';

export class DocumentVersionNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

// A route param naming a metric the tenant's active metric pack does not define — not a stored
// resource that could be missing, so this is a malformed request (400), not a 404.
export class UnknownMetricException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

// A tenant-metric route param that does not match the ontology's own lowercase snake_case
// naming convention — not a stored resource that could be missing, so this is a malformed
// request (400), not a 404.
export class InvalidMetricIdException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

export class CanonicalEntityNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

export class CanonicalEntityNameConflictException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

// A `:packId/:version` route naming a version that does not exist for this tenant — a stored
// resource the caller expected to find.
export class MetricPackNotFoundException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.NOT_FOUND, cause);
  }
}

/**
 * Raised when `MetricPacksService.createDraft` computes a version number that collides with a row
 * another concurrent request just created — the application-layer surface for the same race
 * `metric_packs_tenantId_packId_version_unique` (`metric-pack.schema.ts`) backstops, the same
 * pattern `SourceNameConflictException` uses for its own unique-index race.
 */
export class MetricPackVersionConflictException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

// Publish attempted on a version that is not currently 'draft' — a published version is
// immutable, so a second publish (or a publish targeting an active/retired row) is refused rather
// than silently re-freezing a version that already froze.
export class MetricPackNotDraftException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

// Activate attempted on a version that is not currently 'published' — a draft has not passed the
// publish-time checks yet, and an already-active or retired version has nothing left to promote.
export class MetricPackNotPublishedException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

/**
 * Raised when a publish would drop a metric the parent version defined without the operator
 * acknowledging the removal, or when an acknowledgment names a metric the draft still defines or
 * the parent never defined. A silent removal orphans every `ExtractedFact`/`Conflict` already
 * stamped against that metric and turns the hindsight backtest `unscorable` for them, so the
 * acknowledgment has to name exactly what is actually being dropped.
 */
export class MetricPackMetricRemovalException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}

/**
 * Raised when a publish would change a surviving metric's `canonicalUnit`, or change an existing
 * unit's `toCanonicalFactor`, relative to the parent version. `normalizeFactValue` re-multiplies
 * every stored fact's raw `{amount, unit}` against the *active* pack's factors on every scan, so an
 * edit here would silently reinterpret facts stamped under every earlier version — a version stamp
 * cannot make a factor edit honest the way it can a tolerance edit, which only reads forward.
 */
export class MetricPackFrozenArithmeticException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.CONFLICT, cause);
  }
}
