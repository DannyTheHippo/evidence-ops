/**
 * Retry and liveness policy for `ingest-document-version.workflow.ts`'s activity groups, as plain
 * data.
 *
 * Temporal matches `nonRetryableErrorTypes` against `error.name` — a string, never the class — so
 * these lists and the exception classes they name are coupled by nothing the compiler can see.
 * They live here rather than inline in the workflow so `test/workflows/ingest-retry-policy.spec.ts`
 * can sweep the ingestion feature's exported exception classes and fail when a class this list
 * names disappears, is renamed, or is added without being classified. Pure data with no imports:
 * the workflow bundle only ever pulls constants from this module, so it stays inside the
 * determinism fence (ADR-0003).
 *
 * `BaseException` sets `name` from `new.target` (`src/shared/exceptions/base.exception.ts`), which
 * is what makes every subclass below match by its own class name.
 */

/**
 * How long one attempt of the chunk+embed activity may run before Temporal times it out and
 * schedules the next attempt. Sized for parse + embed plus the post-ingest convergence wait
 * (`IngestionService`'s own `CONVERGENCE_TIMEOUT_MS` budget).
 */
export const INGEST_START_TO_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The whole retry budget for the chunk+embed activity across every attempt. Also the age at which
 * `IngestionService.reconcileStaleAttempts` treats a claimed-but-still-`pending` version as
 * abandoned: past this point no attempt of this activity can still be running.
 */
export const INGEST_SCHEDULE_TO_CLOSE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long Temporal waits for a heartbeat from the chunk+embed activity before failing that
 * attempt. This is what makes heartbeating do anything at all: with no heartbeat timeout declared,
 * an activity whose process has stalled is only noticed at `startToClose`, and nothing cancels the
 * attempt in the meantime. It also opens the channel the server uses to deliver cancellation back
 * to a running activity, which is what lets `IngestionService.ingestVersion` observe an abandoned
 * attempt and record it as `failed` rather than leaving the version `pending`.
 */
export const INGEST_HEARTBEAT_TIMEOUT_MS = 30 * 1000;

/**
 * How often `ingestDocumentVersion` (`src/worker/activities.ts`) emits a heartbeat while the
 * ingest runs. Strictly below `INGEST_HEARTBEAT_TIMEOUT_MS` so an ordinary slow parse or embed
 * never trips the timeout, and the timeout is strictly below `INGEST_START_TO_CLOSE_TIMEOUT_MS` so
 * a stalled attempt is caught by the heartbeat rather than by the much later overall timeout.
 */
export const INGEST_HEARTBEAT_INTERVAL_MS = 10 * 1000;

/**
 * Deterministic failures of the chunk+embed activity: the same bytes and the same configuration
 * reproduce each of them on every attempt, so a retry only delays the version reaching its
 * terminal `failed`/`needs-ocr` state (`IngestionService.recordIngestionFailure`).
 *
 * `'Error'` is deliberately absent and must stay absent: `pdf.parser.ts` throws a bare `Error` for
 * an internal invariant and Nest's own `InternalServerErrorException` leaves `name` at `'Error'`
 * too, so listing it would make every unclassified failure — including a transient Mongo or
 * storage blip — non-retryable.
 *
 * Transient failures are absent by the same rule: `VoyageRateLimitExceededError` and
 * `VoyageRequestFailedError` describe a moment rather than an input, and retrying is exactly what
 * resolves them.
 */
export const INGEST_NON_RETRYABLE_ERROR_TYPES: readonly string[] = [
  // A missing tenantId never appears by retrying (`requireTenantId` in `activities.ts`).
  'MissingTenantId',
  // Voyage's own deterministic refusals: no configured API key, and a response whose shape the
  // client cannot read. Both recur unchanged on the next attempt.
  'VoyageApiKeyMissingError',
  'VoyageInvalidResponseError',
  // A version id that names no row, and a MIME type no parser claims: both are properties of the
  // request, not of the moment it ran.
  'DocumentVersionNotFoundException',
  'UnsupportedMimeTypeException',
  // Terminal parser refusals. Every one is a judgement about bytes that never change — a malformed
  // container, a capacity limit the workbook exceeds, an archive whose declared shape contradicts
  // itself, or a PDF with no text layer to extract.
  'MalformedPdfException',
  'EmptyPdfTextLayerException',
  'MalformedCsvException',
  'MalformedDocxException',
  'MalformedPptxException',
  'MalformedXlsxException',
  'HostileArchiveException',
  // The email container's two terminal refusals: a message whose structure does not hold together,
  // and one whose declared shape exceeds the unwrapping limits. Both are judgements about the same
  // bytes on every attempt.
  'MalformedEmailException',
  'HostileEmailException',
];

/**
 * Deterministic failures of the fact-extraction activity. A tenant's daily spend ceiling does not
 * rise mid-workflow, the pricing table is a fact of the deploy, a request with no tenant is
 * refused identically every time, a schema-invalid model response recurs for the same prose
 * chunk, and a response that stopped at the output cap or the context window recurs identically
 * against the same (or a longer) prompt.
 */
export const EXTRACT_FACTS_NON_RETRYABLE_ERROR_TYPES: readonly string[] = [
  'MissingTenantId',
  'ModelBudgetExceededError',
  'UnknownModelPricingError',
  'ModelSchemaValidationError',
  'ModelOutputTruncatedError',
  'TenantSpendLimitExceededError',
  'ModelRequestMissingTenantError',
];
