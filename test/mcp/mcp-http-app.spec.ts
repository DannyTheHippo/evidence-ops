import type { Express } from 'express';
import request from 'supertest';
import { createMcpHttpApp } from '../../src/mcp/mcp-http-app';
import type { McpServerService } from '../../src/mcp/mcp-server.service';
import type { ToolExecutionContext } from '../../src/features/platform/authz/types/tool-definition.type';
import { UserRole } from '../../src/shared/enums/user-role.enum';

const JSON_RPC_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

/** A JSON-RPC body whose serialized size clears `MCP_JSON_BODY_LIMIT` (21mb) — used to prove the
 *  pre-body gate runs, and refuses, before `express.json` ever attempts to buffer it. */
const OVERSIZED_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { data: 'A'.repeat(22 * 1024 * 1024) },
};

/** One proxy hop, the value a deployment behind `docs/deployment/reverse-proxy.md` sets. */
const ONE_PROXY_HOP = 1;

/** The default: no proxy trusted, every `X-Forwarded-For` entry ignored. */
const NO_PROXY_HOPS = 0;

interface Harness {
  readonly app: Express;
  /** Every key the app handed the pre-auth IP limiter, in call order — the address this app
   *  attributed each request to, which is the thing `trust proxy` decides. */
  readonly keys: string[];
}

/**
 * A stub limiter with a per-key budget, deliberately not the real `McpServerService`: what is under
 * test here is which key each request is attributed to, and a per-key budget of one makes that
 * observable as 401 (admitted, then refused by `authenticate` for holding no PAT) versus 429
 * (refused by the limiter). The admission arithmetic itself is swept in
 * `mcp-server.service.spec.ts`.
 */
function buildApp(trustProxyHops: number, budgetPerKey = 1): Harness {
  const spent = new Map<string, number>();
  const keys: string[] = [];

  const mcpServerService = {
    checkPreAuthIpRateLimit: (ip: string): boolean => {
      keys.push(ip);
      const used = spent.get(ip) ?? 0;
      if (used >= budgetPerKey) {
        return false;
      }
      spent.set(ip, used + 1);
      return true;
    },
    authenticate: (): Promise<null> => Promise.resolve(null),
    checkRateLimit: (): boolean => true,
    buildServer: (): never => {
      throw new Error('unreachable: authenticate refuses every request in this spec');
    },
  };

  return {
    app: createMcpHttpApp(mcpServerService as unknown as McpServerService, trustProxyHops),
    keys,
  };
}

const AUTHENTICATED_CONTEXT: ToolExecutionContext = {
  actorId: 'actor-a',
  tenantId: 'tenant-a',
  role: UserRole.Member,
};

/**
 * Unlike `buildApp` above, `authenticate` resolves a real context — used to prove that a body
 * over `MCP_JSON_BODY_LIMIT` is refused by `express.json` itself (413) once a caller has cleared
 * the pre-body gate, never reaching `buildServer`.
 */
function buildAuthenticatedApp(): { app: Express; buildServer: jest.Mock } {
  const buildServer = jest.fn(() => {
    throw new Error('unreachable: express.json refuses the oversized body first');
  });
  const mcpServerService = {
    checkPreAuthIpRateLimit: (): boolean => true,
    authenticate: (): Promise<ToolExecutionContext> => Promise.resolve(AUTHENTICATED_CONTEXT),
    checkRateLimit: (): boolean => true,
    buildServer,
  };

  return {
    app: createMcpHttpApp(mcpServerService as unknown as McpServerService, NO_PROXY_HOPS),
    buildServer,
  };
}

describe('createMcpHttpApp', () => {
  describe('caller attribution behind a proxy', () => {
    it('should give two callers forwarded from distinct addresses separate budgets', async () => {
      const { app, keys } = buildApp(ONE_PROXY_HOP);

      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', '1.1.1.1')
        .send(JSON_RPC_BODY)
        .expect(401);
      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', '1.1.1.1')
        .send(JSON_RPC_BODY)
        .expect(429);
      // A different forwarded caller is unaffected by the first one exhausting its budget.
      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', '2.2.2.2')
        .send(JSON_RPC_BODY)
        .expect(401);

      expect(keys).toEqual(['1.1.1.1', '1.1.1.1', '2.2.2.2']);
    });

    // The bypass direction: with one hop trusted, the address the proxy appended is the rightmost
    // entry, and anything the client wrote into the header ahead of it is a prefix this app must
    // ignore. Were it read instead, a caller would hop to a fresh budget per forged address — and
    // could also charge its requests to someone else's.
    it('should keep a caller in its own bucket regardless of a forged X-Forwarded-For prefix', async () => {
      const { app, keys } = buildApp(ONE_PROXY_HOP);

      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', '1.1.1.1')
        .send(JSON_RPC_BODY)
        .expect(401);
      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', '9.9.9.9, 1.1.1.1')
        .send(JSON_RPC_BODY)
        .expect(429);
      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', 'not-an-address, 8.8.8.8, 1.1.1.1')
        .send(JSON_RPC_BODY)
        .expect(429);

      expect(keys).toEqual(['1.1.1.1', '1.1.1.1', '1.1.1.1']);
    });

    // The default, and the direction a misconfiguration must fail in: with no proxy trusted the
    // header is inert, every caller is attributed to the socket peer, and they share one budget.
    // That over-limits callers behind a real proxy; it never lets one claim an address.
    it('should ignore X-Forwarded-For entirely when no proxy hop is trusted', async () => {
      const { app, keys } = buildApp(NO_PROXY_HOPS);

      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', '1.1.1.1')
        .send(JSON_RPC_BODY)
        .expect(401);
      await request(app)
        .post('/mcp')
        .set('X-Forwarded-For', '2.2.2.2')
        .send(JSON_RPC_BODY)
        .expect(429);

      expect(keys).toEqual([
        expect.stringContaining('127.0.0.1') as string,
        expect.stringContaining('127.0.0.1') as string,
      ]);
    });
  });

  describe('body size ceiling', () => {
    // The pre-body gate runs ahead of express.json, so an unauthenticated caller is refused
    // before this process ever attempts to buffer an oversized body — proven here by getting a
    // clean 401, not the connection-level failure a body over the limit would otherwise cause.
    it('should 401 an oversized body with no PAT, having called authenticate but never buildServer', async () => {
      const { app, keys } = buildApp(NO_PROXY_HOPS);

      await request(app).post('/mcp').send(OVERSIZED_BODY).expect(401);

      expect(keys).toHaveLength(1);
    });

    // Once the pre-body gate admits a caller, express.json applies MCP_JSON_BODY_LIMIT and
    // refuses the oversized body itself — buildServer is never reached because the body never
    // finishes parsing.
    it('should 413 an oversized body from an authenticated caller, never reaching buildServer', async () => {
      const { app, buildServer } = buildAuthenticatedApp();

      await request(app).post('/mcp').send(OVERSIZED_BODY).expect(413);

      expect(buildServer).not.toHaveBeenCalled();
    });
  });

  describe('route table', () => {
    it.each(['get', 'delete'] as const)(
      'should answer %s on the MCP route with 405, reaching no limiter',
      async (method) => {
        const { app, keys } = buildApp(ONE_PROXY_HOP);

        const response = await request(app)[method]('/mcp').expect(405);

        expect(response.body).toEqual({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed in stateless mode' },
          id: null,
        });
        expect(keys).toEqual([]);
      },
    );
  });
});
