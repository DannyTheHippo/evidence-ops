import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * The number of units `McpServerService.checkRateLimit` should charge for one HTTP POST to
 * `MCP_ROUTE_PATH`, given the already-parsed JSON-RPC body `express.json()` produced.
 *
 * A non-array body always costs exactly `1`, whatever that body turns out to contain
 * (`transport.handleRequest` validates it afterward). An array body — a JSON-RPC batch — costs the
 * number of elements that are themselves JSON-RPC *requests*: carrying both a `method` and an
 * `id`, per `isJSONRPCRequest`. Only a request dispatches a handler through `Server`'s
 * `setRequestHandler` (and, for `tools/call`, reaches `ToolExecutorService`); a batched
 * notification or response is only ever echoed to `onmessage` and never triggers a tool call. The
 * result is floored at `1`: every POST that reaches the limiter is charged at least one unit,
 * whatever its body shape, so a batch carrying only notifications or responses cannot pay for its
 * `PatTokenVerifier.verify` lookup for free.
 */
export function countRateLimitCost(rawBody: unknown): number {
  if (!Array.isArray(rawBody)) {
    return 1;
  }

  return Math.max(1, rawBody.filter(isJSONRPCRequest).length);
}
