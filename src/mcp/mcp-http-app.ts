import express from 'express';
import type { Express, Request, Response } from 'express';
import { createMcpRequestHandler, JSON_RPC_ERROR, sendJsonRpcError } from './mcp-request-handler';
import type { McpServerService } from './mcp-server.service';
import { MCP_JSON_BODY_LIMIT, MCP_ROUTE_PATH } from './mcp.constant';

/**
 * Builds this process's express app, kept out of `./main.ts` — which boots `McpModule` and so reads
 * `.env` the moment it is imported — for the same reason `createMcpRequestHandler` lives in its own
 * module: `test/mcp/mcp-http-app.spec.ts` drives the real app over a socket, so what is asserted is
 * the wiring this process runs rather than a copy of it rebuilt in a spec.
 *
 * `trustProxyHops` is the number of reverse proxies in front of this listener (`TRUST_PROXY_HOPS`,
 * `app.trustProxyHops` — the same knob `src/config/app.config.ts` applies to the API process).
 * `req.ip` is the rightmost address not attributable to those hops, and the pre-auth IP limiter
 * (`McpServerService.checkPreAuthIpRateLimit`, applied in `createMcpRequestHandler`) keys on it, so
 * this number decides who shares a bucket with whom:
 *
 * - Too low — 0 while a proxy is in front — collapses every caller onto the proxy's own address and
 *   one bucket, so one hostile caller exhausts the budget for everyone. That is the *default*
 *   direction (`TRUST_PROXY_HOPS` defaults to 0) because it over-limits rather than under-limits: a
 *   deployment that forgets to configure this refuses too much, never too little, and no caller can
 *   claim an address that is not theirs.
 * - Too high — more hops than actually exist — lets a caller reaching this listener directly write
 *   its own `req.ip` into `X-Forwarded-For` and hop buckets freely, which is a limiter bypass.
 *
 * A hop count above 0 is therefore only correct while two deployment properties hold, both of which
 * `docs/global/deployment-hardening.md` configures: this listener is reachable only through the proxy
 * (the compose publish binds it to loopback), and the proxy *appends* the peer address to any
 * client-supplied `X-Forwarded-For` (`$proxy_add_x_forwarded_for`) rather than passing the header
 * through. Together they make the address this app selects the one the proxy observed, and leave a
 * client-supplied prefix inert.
 */
export function createMcpHttpApp(
  mcpServerService: McpServerService,
  trustProxyHops: number,
): Express {
  const app = express();

  app.set('trust proxy', trustProxyHops);
  app.use(express.json({ limit: MCP_JSON_BODY_LIMIT }));

  app.post(MCP_ROUTE_PATH, createMcpRequestHandler(mcpServerService));

  // Streamable HTTP's GET (server-initiated stream) and DELETE (session termination) both apply
  // only to stateful mode — this process never generates a session id, so neither has anything to
  // do.
  const methodNotAllowed = (_req: Request, res: Response): void =>
    sendJsonRpcError(res, 405, JSON_RPC_ERROR.methodNotAllowed);
  app.get(MCP_ROUTE_PATH, methodNotAllowed);
  app.delete(MCP_ROUTE_PATH, methodNotAllowed);

  return app;
}
