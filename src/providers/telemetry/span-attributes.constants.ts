/**
 * Single source for every span attribute name this codebase emits. `gen_ai.*` follows the
 * OpenTelemetry Semantic Conventions for Generative AI (still `/incubating`, so read from here
 * rather than `@opentelemetry/semantic-conventions` — pulling in an unstable entrypoint for a
 * handful of strings is worse than owning them). `evidence.*` is this project's own namespace.
 * Nothing outside this file may hardcode either prefix — grep for `'gen_ai.` or `'evidence.` in a
 * review to catch a drift.
 */
export const GEN_AI_ATTRIBUTES = {
  SYSTEM: 'gen_ai.system',
  OPERATION_NAME: 'gen_ai.operation.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
} as const;

/** Event names for the dev-only prompt/completion capture (`TracingModelProvider`) — span
 *  *events*, never attributes, so a backend that samples/indexes attributes by default doesn't
 *  index evidence text (see `docs/threat-model.md` residual risks). */
export const GEN_AI_CONTENT_EVENTS = {
  PROMPT: 'gen_ai.content.prompt',
  COMPLETION: 'gen_ai.content.completion',
} as const;

export const EVIDENCE_ATTRIBUTES = {
  COST_USD: 'evidence.cost_usd',
  RETRIEVAL_MODE: 'evidence.retrieval.mode',
  CLAIM_COVERAGE: 'evidence.claim_coverage',
  CITATIONS_VERIFIED: 'evidence.citations.verified',
  /** Joins `CorrelationMiddleware`'s id to the active span — see `AsyncLocalStorageMiddleware`. */
  CORRELATION_ID: 'evidence.correlation_id',
} as const;
