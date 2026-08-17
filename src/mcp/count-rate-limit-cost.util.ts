import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * The number of units `McpServerService.checkRateLimit` should charge for one HTTP POST to
 * `MCP_ROUTE_PATH`, given the already-parsed JSON-RPC body `express.json()` produced.
 *
 * A non-array body always costs exactly `1` — the pre-batching behaviour of charging once per
 * POST is preserved unchanged for the common single-message case, whatever that body turns out to
 * contain (`transport.handleRequest` validates it afterward). An array body — a JSON-RPC batch —
 * costs the number of elements that are themselves JSON-RPC *requests*: carrying both a `method`
 * and an `id`, per `isJSONRPCRequest`. Only a request dispatches a handler through `Server`'s
 * `setRequestHandler` (and, for `tools/call`, reaches `ToolExecutorService`); a batched
 * notification or response is only ever echoed to `onmessage` and never triggers a tool call, so it
 * costs nothing. Charging one unit per POST regardless of how many requests its body carried is
 * exactly what let a single call spend one unit of budget while the SDK dispatched every request in
 * an arbitrarily large batch array — this is what closes that gap.
 */
export function countRateLimitCost(rawBody: unknown): number {
  if (!Array.isArray(rawBody)) {
    return 1;
  }

  return rawBody.filter(isJSONRPCRequest).length;
}
