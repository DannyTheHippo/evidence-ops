import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypedConfigService } from '../config/environment/typed-config.service';
import { createMcpHttpApp } from './mcp-http-app';
import { McpServerService } from './mcp-server.service';
import { McpModule } from './mcp.module';

/**
 * Third process, per the same shape ADR-0003 established for the Temporal worker (`src/worker/main.ts`):
 * boot the DI slice (`McpModule`), then layer a plain `express()` app on top by hand — this
 * process needs Streamable HTTP, which is an HTTP concern the application-context boot never
 * gives it, unlike the worker's Temporal poll loop. The app itself is built by `createMcpHttpApp`
 * (`./mcp-http-app.ts`), including the `trust proxy` hop count every IP-keyed decision on this
 * surface depends on; see `createMcpRequestHandler`'s own doc comment (`./mcp-request-handler.ts`)
 * for what the one route it registers actually does.
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(McpModule, { bufferLogs: true });
  const config = app.get(TypedConfigService);
  const mcpServerService = app.get(McpServerService);

  const httpApp = createMcpHttpApp(mcpServerService, config.app.trustProxyHops);

  httpApp.listen(config.mcp.port, () => {
    Logger.log(`MCP server listening on port ${config.mcp.port}`, 'Mcp');
  });
}

run().catch((error: unknown) => {
  console.error('Fatal MCP server failure:', error);
  process.exit(1);
});
