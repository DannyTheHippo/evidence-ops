// Comfortably under common reverse-proxy / load-balancer read-idle timeouts (nginx's own default
// is 60s; this repo's `web/nginx.conf` sets 300s for the API location) — keeps every SSE
// connection producing traffic often enough that nothing in the chain decides it went idle and
// drops it, even for a stream whose underlying data changes rarely.
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

// The `catchError` fallback on every SSE stream (`QaService.streamAnswer`,
// `WorkflowRunsService.streamRun`, `DocumentsService.streamList`) emits this instead of
// `(error as Error).message` — an SSE `catchError` sits outside `GlobalExceptionFilter`, so a
// driver-level failure's raw message (Mongo namespace, index name, sometimes topology detail)
// would otherwise reach the browser directly. Mirrors `GlobalExceptionFilter`'s own withheld-detail
// text; the real error is still logged server-side by each stream's `catchError`.
export const SSE_STREAM_ERROR_MESSAGE = 'Internal server error';
