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

// How often each of the three SSE streams (`QaService.streamAnswer`, `WorkflowRunsService.streamRun`,
// `DocumentsService.streamList`) re-reads the connecting user via `reauthTicks$`
// (`stream-session.util.ts`) and closes if the session is gone or moved tenants. This is the
// window a revoked or cross-tenant session can keep an already-open stream alive — worth trading
// against the extra Mongo lookup a tighter interval would add on every open connection.
export const SSE_REAUTH_INTERVAL_MS = 30_000;

// The window `shouldRecordStreamView` (`stream-session.util.ts`) collapses a reconnecting client's
// repeated stream opens into a single audit row for — long enough to absorb a burst of network-blip
// reconnects, short enough that a caller genuinely coming back later still gets a fresh row.
export const SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS = 300_000;
