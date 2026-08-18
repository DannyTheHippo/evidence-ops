import type { Request, Response } from 'express';
import type { ToolExecutionContext } from '../../src/features/platform/authz/types/tool-definition.type';
import { createMcpRequestHandler, JSON_RPC_ERROR } from '../../src/mcp/mcp-request-handler';
import type { McpServerService } from '../../src/mcp/mcp-server.service';
import { UserRole } from '../../src/shared/enums/user-role.enum';

const TENANT_A_CONTEXT: ToolExecutionContext = {
  actorId: 'actor-a',
  tenantId: 'tenant-a',
  role: UserRole.Member,
};

type MockMcpServerService = jest.Mocked<
  Pick<
    McpServerService,
    'checkPreAuthIpRateLimit' | 'authenticate' | 'checkRateLimit' | 'buildServer'
  >
>;

function buildMcpServerService(): MockMcpServerService {
  return {
    checkPreAuthIpRateLimit: jest.fn().mockReturnValue(true),
    authenticate: jest.fn().mockResolvedValue(TENANT_A_CONTEXT),
    checkRateLimit: jest.fn().mockReturnValue(true),
    buildServer: jest.fn(),
  };
}

function buildRequest(overrides: Partial<Request> = {}): Request {
  return {
    ip: '1.2.3.4',
    headers: {},
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
    ...overrides,
  } as Request;
}

/**
 * Returns `status`/`json` as standalone locals rather than properties read back off `res`: reading
 * `res.status`/`res.json` off the `Response`-typed object reads as an unbound method reference and
 * trips `@typescript-eslint/unbound-method`. The locals are the exact same `jest.fn()` instances the
 * handler invokes, so assertions on them are equally strong.
 */
function buildResponse(): {
  res: Response;
  status: jest.Mock<{ json: typeof json }, [number]>;
  json: jest.Mock<void, [Record<string, unknown>]>;
} {
  const json = jest.fn<void, [Record<string, unknown>]>();
  const status = jest.fn<{ json: typeof json }, [number]>().mockReturnValue({ json });
  const res = { status, json, on: jest.fn(), headersSent: false } as unknown as Response;
  return { res, status, json };
}

describe('createMcpRequestHandler', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  // Regression for the pre-auth rate-limit gap: the only limiter keyed on the verified `actorId`,
  // so a caller who never authenticates was never limited, and every one of their requests still
  // cost a `PatTokenVerifier.verify` Mongo lookup. The IP-keyed limiter must refuse before
  // `authenticate` is ever called — asserting the verifier was never reached, not just the status.
  it('should refuse a request over the pre-auth IP budget without ever calling authenticate', async () => {
    const mcpServerService = buildMcpServerService();
    mcpServerService.checkPreAuthIpRateLimit.mockReturnValue(false);
    const handler = createMcpRequestHandler(mcpServerService as unknown as McpServerService);
    const req = buildRequest();
    const { res, status, json } = buildResponse();

    await handler(req, res);

    expect(mcpServerService.checkPreAuthIpRateLimit).toHaveBeenCalledWith('1.2.3.4');
    expect(mcpServerService.authenticate).not.toHaveBeenCalled();
    expect(mcpServerService.checkRateLimit).not.toHaveBeenCalled();
    expect(mcpServerService.buildServer).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: JSON_RPC_ERROR.rateLimited }),
    );
  });

  it('should key the pre-auth limiter on the caller IP, falling back to a fixed tracker when unresolved', async () => {
    const mcpServerService = buildMcpServerService();
    // Refused, so the handler returns right after the gate check — this test only cares what key
    // reached the limiter, not the rest of the request lifecycle the other tests already cover.
    mcpServerService.checkPreAuthIpRateLimit.mockReturnValue(false);
    const handler = createMcpRequestHandler(mcpServerService as unknown as McpServerService);
    const req = buildRequest({ ip: undefined });
    const { res } = buildResponse();

    await handler(req, res);

    expect(mcpServerService.checkPreAuthIpRateLimit).toHaveBeenCalledWith('unresolved');
  });

  it('should call authenticate once the pre-auth limiter admits the request', async () => {
    const mcpServerService = buildMcpServerService();
    mcpServerService.authenticate.mockResolvedValue(null);
    const handler = createMcpRequestHandler(mcpServerService as unknown as McpServerService);
    const req = buildRequest({ headers: { authorization: 'Bearer x' } });
    const { res, status } = buildResponse();

    await handler(req, res);

    expect(mcpServerService.checkPreAuthIpRateLimit).toHaveBeenCalledWith('1.2.3.4');
    expect(mcpServerService.authenticate).toHaveBeenCalledWith('Bearer x');
    expect(status).toHaveBeenCalledWith(401);
  });

  it('should refuse an authenticated caller over the post-auth budget without touching buildServer', async () => {
    const mcpServerService = buildMcpServerService();
    mcpServerService.checkRateLimit.mockReturnValue(false);
    const handler = createMcpRequestHandler(mcpServerService as unknown as McpServerService);
    const req = buildRequest({ headers: { authorization: 'Bearer x' } });
    const { res, status } = buildResponse();

    await handler(req, res);

    expect(mcpServerService.checkRateLimit).toHaveBeenCalledWith('actor-a', 1);
    expect(mcpServerService.buildServer).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(429);
  });
});
