import 'dotenv/config';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { Request, Response } from 'express';
import { TypedConfigService } from '../config/environment/typed-config.service';
import { countRateLimitCost } from './count-rate-limit-cost.util';
import { McpServerService } from './mcp-server.service';
import { MCP_JSON_BODY_LIMIT, MCP_ROUTE_PATH } from './mcp.constant';
import { McpModule } from './mcp.module';

const JSON_RPC_ERROR = {
  unauthorized: { code: -32001, message: 'Unauthorized: missing, invalid, or expired PAT' },
  rateLimited: { code: -32000, message: 'Rate limit exceeded' },
  methodNotAllowed: { code: -32000, message: 'Method not allowed in stateless mode' },
  internal: { code: -32603, message: 'Internal server error' },
} as const;

function sendJsonRpcError(
  res: Response,
  status: number,
  error: { code: number; message: string },
): void {
  res.status(status).json({ jsonrpc: '2.0', error, id: null });
}

/**
 * Third process, per the same shape ADR-0003 established for the Temporal worker (`src/worker/main.ts`):
 * boot the DI slice (`McpModule`), then layer a plain `express()` app on top by hand — this
 * process needs Streamable HTTP, which is an HTTP concern the application-context boot never
 * gives it, unlike the worker's Temporal poll loop.
 *
 * One `Server`/`StreamableHTTPServerTransport` pair per request. The `res.on('close', …)` cleanup
 * listener is registered before `server.connect` — mirroring the SDK's own stateless example,
 * `examples/server/simpleStatelessStreamableHttp.ts`, with `sessionIdGenerator: undefined` — so a
 * response that finishes before `handleRequest` returns still fires it; the `catch` block below
 * closes both explicitly as well (idempotent — `StreamableHTTPServerTransport.close` and
 * `Server.close` both guard against a second call), since a throw from `connect`/`handleRequest`
 * is not guaranteed to ever produce the `close` event that listener waits for. Nothing here
 * persists a session between requests, so a caller's identity can never leak from one HTTP
 * request into another's tool calls.
 *
 * Every request is gated, in order, before any MCP protocol work starts: `authenticate` (fails
 * CLOSED — a missing, malformed, revoked, or expired PAT never reaches `buildServer`), then
 * `checkRateLimit` (fails CLOSED — a hit against `config.mcp.rateLimitPerMinute` refuses the
 * request). The rate limit is charged per JSON-RPC request actually present in the body
 * (`countRateLimitCost`), not once per POST — the SDK dispatches every request inside a JSON-RPC
 * batch array, so charging a flat one unit per HTTP call let a single POST carrying hundreds of
 * batched `tools/call` requests spend one unit of budget while triggering hundreds of tool calls.
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(McpModule, { bufferLogs: true });
  const config = app.get(TypedConfigService);
  const mcpServerService = app.get(McpServerService);

  const httpApp = express();
  httpApp.use(express.json({ limit: MCP_JSON_BODY_LIMIT }));

  httpApp.post(MCP_ROUTE_PATH, async (req: Request, res: Response) => {
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
  });

  // Streamable HTTP's GET (server-initiated stream) and DELETE (session termination) both apply
  // only to stateful mode — this process never generates a session id, so neither has anything to
  // do.
  const methodNotAllowed = (_req: Request, res: Response): void =>
    sendJsonRpcError(res, 405, JSON_RPC_ERROR.methodNotAllowed);
  httpApp.get(MCP_ROUTE_PATH, methodNotAllowed);
  httpApp.delete(MCP_ROUTE_PATH, methodNotAllowed);

  httpApp.listen(config.mcp.port, () => {
    Logger.log(`MCP server listening on port ${config.mcp.port}`, 'Mcp');
  });
}

run().catch((error: unknown) => {
  console.error('Fatal MCP server failure:', error);
  process.exit(1);
});
