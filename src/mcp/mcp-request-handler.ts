import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { ToolExecutionContext } from '../features/platform/authz/types/tool-definition.type';
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
 * Refuses a request from the pre-body gate: drains the still-arriving body — discarding it chunk
 * by chunk rather than accumulating it, so memory use stays O(1) regardless of body size — and
 * waits for that drain to finish before sending the error. The wait costs network time on an
 * oversized body, never memory; without it, ending the response while bytes are still unread on
 * the socket makes the OS reset the connection under the caller instead of delivering a clean
 * HTTP status.
 */
function refuse(
  req: Request,
  res: Response,
  status: number,
  error: { code: number; message: string },
): void {
  if (req.readableEnded) {
    sendJsonRpcError(res, status, error);
    return;
  }
  req.resume();
  req.once('end', () => sendJsonRpcError(res, status, error));
  req.once('error', () => sendJsonRpcError(res, status, error));
}

/**
 * Runs, on `MCP_ROUTE_PATH`, ahead of `express.json` (`mcp-http-app.ts`) — before this gate, no
 * middleware on this route has parsed or accumulated a byte of the request body, so an oversized
 * or unauthenticated POST is refused before it costs any allocation proportional to its size.
 * Fails CLOSED at both steps: `checkPreAuthIpRateLimit` (a hit against
 * `config.mcp.preAuthIpRateLimitMaxRequests`, keyed on `req.ip`, refuses the request before it
 * costs a `PatTokenVerifier.verify` lookup) runs first, then `authenticate` (a missing, malformed,
 * revoked, or expired PAT never admits the request). Only a call that clears both writes
 * `res.locals.mcpContext` and calls `next()` — `createMcpRequestHandler` treats that property as
 * the sole proof a request was authenticated, so this gate is the only writer of it.
 */
export function createMcpPreBodyGate(
  mcpServerService: McpServerService,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!mcpServerService.checkPreAuthIpRateLimit(req.ip ?? UNRESOLVED_IP_TRACKER)) {
      refuse(req, res, 429, JSON_RPC_ERROR.rateLimited);
      return;
    }

    const context = await mcpServerService.authenticate(req.headers.authorization);
    if (!context) {
      refuse(req, res, 401, JSON_RPC_ERROR.unauthorized);
      return;
    }

    res.locals.mcpContext = context;
    next();
  };
}

/**
 * The `POST /mcp` handler, kept in its own module — importing `McpServerService` only for its
 * type — so that `test/mcp/main.spec.ts` can exercise it without dragging in `./mcp.module`'s
 * `ConfigModule.forRoot()`, which reads `.env` the moment that module is imported.
 * `createMcpHttpApp` (`./mcp-http-app.ts`) wires the returned function onto the route, behind
 * `createMcpPreBodyGate` and `express.json`; nothing here depends on `NestFactory` having run.
 *
 * `res.locals.mcpContext`, set only by `createMcpPreBodyGate`, is read here as the one proof the
 * caller authenticated — fails CLOSED: its absence 401s rather than falling through to a default
 * identity, which covers both a caller this gate genuinely refused and a route wired without the
 * gate ahead of it. `checkRateLimit` runs next (fails CLOSED — a hit against
 * `config.mcp.rateLimitPerMinute` refuses the request), charged per JSON-RPC request actually
 * present in the body (`countRateLimitCost`), not once per POST — the SDK dispatches every request
 * inside a JSON-RPC batch array, so charging a flat one unit per HTTP call let a single POST
 * carrying hundreds of batched `tools/call` requests spend one unit of budget while triggering
 * hundreds of tool calls. This limiter and the pre-body gate's IP limiter are deliberately separate
 * calls against separate windows on `McpServerService`: the first bounds a caller who has proven
 * nothing yet, this one bounds a verified actor's budget, and neither can substitute for the other.
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
    const context = res.locals.mcpContext as ToolExecutionContext | undefined;
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
