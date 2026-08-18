import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { Request, Response } from 'express';
import { TypedConfigService } from '../config/environment/typed-config.service';
import { createMcpRequestHandler, JSON_RPC_ERROR, sendJsonRpcError } from './mcp-request-handler';
import { McpServerService } from './mcp-server.service';
import { MCP_JSON_BODY_LIMIT, MCP_ROUTE_PATH } from './mcp.constant';
import { McpModule } from './mcp.module';

/**
 * Third process, per the same shape ADR-0003 established for the Temporal worker (`src/worker/main.ts`):
 * boot the DI slice (`McpModule`), then layer a plain `express()` app on top by hand — this
 * process needs Streamable HTTP, which is an HTTP concern the application-context boot never
 * gives it, unlike the worker's Temporal poll loop. See `createMcpRequestHandler`'s own doc
 * comment (`./mcp-request-handler.ts`) for what the one route it registers actually does, and why
 * that handler lives in its own module rather than here.
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(McpModule, { bufferLogs: true });
  const config = app.get(TypedConfigService);
  const mcpServerService = app.get(McpServerService);

  const httpApp = express();
  httpApp.use(express.json({ limit: MCP_JSON_BODY_LIMIT }));

  httpApp.post(MCP_ROUTE_PATH, createMcpRequestHandler(mcpServerService));

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
