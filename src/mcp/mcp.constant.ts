import packageJSON from '../../package.json';

/** `Implementation` (`{name, version}`) this process reports to a connecting MCP client during
 *  initialization — mirrors `swagger.config.ts`'s reuse of the same `package.json` version so the
 *  API surface and this one never drift apart on which release they report. */
export const MCP_SERVER_INFO = { name: `${packageJSON.name}-mcp`, version: packageJSON.version };

/** The only route this process serves — Streamable HTTP per the MCP spec, one path for
 *  `POST`/`GET`/`DELETE`. */
export const MCP_ROUTE_PATH = '/mcp';

/** Width of the interval `McpServerService.checkRateLimit` bounds: its budget applies to every
 *  interval this wide, not only to consecutive ones. */
export const MCP_RATE_LIMIT_WINDOW_MS = 60_000;

/** Upper bound on how many keys `McpServerService`'s rolling-window sweep visits per call — see
 *  that method's own doc comment for why a persistent cursor bounds this instead of a whole-map
 *  walk. Comfortably above the key count either limiter's own tests exercise, so a small map is
 *  still fully swept in one call; comfortably below any key count a flood could reach, so a large
 *  map never turns one call's bookkeeping into the thing the limiter exists to bound. */
export const MCP_RATE_LIMIT_SWEEP_BATCH_SIZE = 64;

/**
 * `express.json()` body-size ceiling for `MCP_ROUTE_PATH`, set explicitly rather than left to
 * Express's own 100kB default. A JSON-RPC batch is a legitimate protocol feature — many
 * `tools/call` requests sharing one HTTP body — and `countRateLimitCost` charges every request
 * inside it its own unit against `McpServerService.checkRateLimit` regardless of how many share a
 * body, so this ceiling is not what bounds batch size or call volume. It exists only to cap the
 * memory one POST can claim while Express buffers and parses it: comfortably above what a
 * legitimate batch of small tool-call arguments (a query string, an answer id, a conflict id/fact
 * id pair) needs, while still refusing a single oversized body outright rather than letting it
 * grow unbounded.
 */
export const MCP_JSON_BODY_LIMIT = '256kb';

/**
 * The three audit actions every `tools/call` writes exactly one of, at the protocol boundary in
 * `McpServerService.buildServer`. The outcome lives in the action name, matching the closed
 * vocabulary the rest of the audit log uses (`approvals.decided`, `sources.sync_requested`); the
 * tool name and, for a refusal, the chokepoint's reason ride in `AuditEvent.toolName`/
 * `AuditEvent.refusalReason` so nothing model-controlled ever widens the action vocabulary itself.
 * `MCP_TOOL_CALL_FAILED_ACTION` is distinct from both: a registered, authorized, well-formed call
 * whose handler itself threw (a lookup miss, for one) is neither a policy refusal nor a success,
 * and logging it as either would make a handler exception indistinguishable from a routine denial
 * or a real result — the exact ambiguity that let id enumeration go unaudited.
 */
export const MCP_TOOL_CALL_EXECUTED_ACTION = 'mcp.tool_call.executed';
export const MCP_TOOL_CALL_REFUSED_ACTION = 'mcp.tool_call.refused';
export const MCP_TOOL_CALL_FAILED_ACTION = 'mcp.tool_call.failed';
