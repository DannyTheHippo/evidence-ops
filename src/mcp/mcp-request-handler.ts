import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { countRateLimitCost } from './count-rate-limit-cost.util';
import type { McpServerService } from './mcp-server.service';

export const JSON_RPC_ERROR = {
  unauthorized: { code: -32001, message: 'Unauthorized: missing, invalid, or expired PAT' },
  rateLimited: { code: -32000, message: 'Rate limit exceeded' },
  methodNotAllowed: { code: -32000, message: 'Method not allowed in stateless mode' },
  internal: { code: -32603, message: 'Internal server error' },
} as const;

export function sendJsonRpcError(
  res: Response,
  status: number,
  error: { code: number; message: string },
): void {
  res.status(status).json({ jsonrpc: '2.0', error, id: null });
}

const UNRESOLVED_IP_TRACKER = 'unresolved';

/**
 * The `POST /mcp` handler, kept in its own module — importing `McpServerService` only for its
 * type — so that `test/mcp/main.spec.ts` can exercise it without dragging in `./mcp.module`'s
 * `ConfigModule.forRoot()`, which reads `.env` the moment that module is imported.
 * `createMcpHttpApp` (`./mcp-http-app.ts`) wires the returned function onto the route; nothing here
 * depends on `NestFactory` having run.
 *
 * Every request is gated, in order, before any MCP protocol work starts: `checkPreAuthIpRateLimit`
 * (fails CLOSED — a hit against `config.mcp.preAuthIpRateLimitMaxRequests`, keyed on `req.ip`,
 * refuses the request before it costs a `PatTokenVerifier.verify` lookup), then `authenticate`
 * (fails CLOSED — a missing, malformed, revoked, or expired PAT never reaches `buildServer`), then
 * `checkRateLimit` (fails CLOSED — a hit against `config.mcp.rateLimitPerMinute` refuses the
 * request). The rate limit is charged per JSON-RPC request actually present in the body
 * (`countRateLimitCost`), not once per POST — the SDK dispatches every request inside a JSON-RPC
 * batch array, so charging a flat one unit per HTTP call let a single POST carrying hundreds of
 * batched `tools/call` requests spend one unit of budget while triggering hundreds of tool calls.
 * The pre-auth and post-auth limiters are deliberately separate calls against separate windows on
 * `McpServerService` (`checkPreAuthIpRateLimit` vs `checkRateLimit`): the first bounds a caller who
 * has proven nothing yet, the second bounds a verified actor's budget, and neither can substitute
 * for the other.
 *
 * One `Server`/`StreamableHTTPServerTransport` pair per request, once the gates above pass. The
 * `res.on('close', …)` cleanup listener is registered before `server.connect` — mirroring the
 * SDK's own stateless example, `examples/server/simpleStatelessStreamableHttp.ts`, with
 * `sessionIdGenerator: undefined` — so a response that finishes before `handleRequest` returns
 * still fires it; the `catch` block below closes both explicitly as well (idempotent —
 * `StreamableHTTPServerTransport.close` and `Server.close` both guard against a second call),
 * since a throw from `connect`/`handleRequest` is not guaranteed to ever produce the `close` event
 * that listener waits for. Nothing here persists a session between requests, so a caller's
 * identity can never leak from one HTTP request into another's tool calls.
 */
export function createMcpRequestHandler(
  mcpServerService: McpServerService,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    if (!mcpServerService.checkPreAuthIpRateLimit(req.ip ?? UNRESOLVED_IP_TRACKER)) {
      sendJsonRpcError(res, 429, JSON_RPC_ERROR.rateLimited);
      return;
    }

    const context = await mcpServerService.authenticate(req.headers.authorization);
    if (!context) {
      sendJsonRpcError(res, 401, JSON_RPC_ERROR.unauthorized);
      return;
    }

    const cost = countRateLimitCost(req.body);
    if (!mcpServerService.checkRateLimit(context.actorId, cost)) {
      sendJsonRpcError(res, 429, JSON_RPC_ERROR.rateLimited);
      return;
    }

    const server = mcpServerService.buildServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to handle MCP request: ${message}`, 'Mcp');
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, JSON_RPC_ERROR.internal);
      }
      void transport.close();
      void server.close();
    }
  };
}
