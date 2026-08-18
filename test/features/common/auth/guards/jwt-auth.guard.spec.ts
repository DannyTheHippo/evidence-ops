import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TypedConfigService } from '../../../../../src/config/environment/typed-config.service';
import { JwtAuthGuard } from '../../../../../src/features/common/auth/guards/jwt-auth.guard';
import { JwtPayload } from '../../../../../src/features/common/auth/types/jwt-payload.type';
import { NodeEnv } from '../../../../../src/shared/enums/global/node-env.enum';
import { UserRole } from '../../../../../src/shared/enums/user-role.enum';
import { AlsContext } from '../../../../../src/shared/types/als-context.type';
import { AuthenticatedRequest } from '../../../../../src/shared/types/authenticated-request.type';
import { getMockTypedConfig } from '../../../../utils/get-mock-typed-config';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  let alsStore: AlsContext;

  const mockAls = { getStore: jest.fn() };
  // Declared as plain `jest.Mock`s rather than resolved off the injected `JwtService`: reading
  // `jwtService.verifyAsync` back out of the container types it as an interface *method*, so
  // passing it to `expect()` reads as an unbound method reference and trips
  // `@typescript-eslint/unbound-method`. Same reasoning as `documents.service.spec.ts:33-36`.
  const mockJwtService = { verifyAsync: jest.fn() };

  const buildContext = (
    headers: Record<string, string> = {},
  ): { context: ExecutionContext; request: Partial<AuthenticatedRequest> } => {
    const request: Partial<AuthenticatedRequest> = { headers };
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    return { context, request };
  };

  // `getMockTypedConfig` merges overrides per-namespace, so `app` has to carry its full shape,
  // not just `env` — a partial override would drop the rest of the namespace.
  const buildGuard = async (
    env: NodeEnv,
  ): Promise<{ guard: JwtAuthGuard; reflector: Reflector }> => {
    const config = getMockTypedConfig({
      app: { env, port: 3000, logLevel: 'debug', url: 'http://localhost:3000', trustProxyHops: 0 },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: JwtService, useValue: mockJwtService },
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn().mockReturnValue(false) } },
        { provide: TypedConfigService, useValue: config },
        { provide: AsyncLocalStorage, useValue: mockAls },
      ],
    }).compile();

    return { guard: module.get(JwtAuthGuard), reflector: module.get(Reflector) };
  };

  beforeEach(async () => {
    alsStore = { 'correlation-id': 'test-correlation-id' };
    mockAls.getStore.mockReturnValue(alsStore);

    ({ guard, reflector } = await buildGuard(NodeEnv.TEST));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should allow a public route without checking a token', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
    const { context } = buildContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockJwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('should throw UnauthorizedException when no session cookie is present', async () => {
    const { context } = buildContext();

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when the token fails verification', async () => {
    mockJwtService.verifyAsync.mockRejectedValueOnce(new Error('bad signature'));
    const { context } = buildContext({ cookie: 'eo_session=some-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  // Fail-closed regression: a token signed before tenancy landed verifies fine (same secret,
  // not expired) but carries no tenantId, and must still be rejected rather than treated as
  // tenant-less.
  it('should throw UnauthorizedException when the payload is missing tenantId', async () => {
    const legacyPayload = { sub: 'user-id', email: 'user@example.com', role: UserRole.Member };
    mockJwtService.verifyAsync.mockResolvedValueOnce(legacyPayload);
    const { context } = buildContext({ cookie: 'eo_session=legacy-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when the payload is missing role', async () => {
    const legacyPayload = { sub: 'user-id', email: 'user@example.com', tenantId: 'default' };
    mockJwtService.verifyAsync.mockResolvedValueOnce(legacyPayload);
    const { context } = buildContext({ cookie: 'eo_session=legacy-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should set request.user with all four fields and write both ALS keys on a valid payload', async () => {
    const payload: JwtPayload = {
      sub: 'user-id',
      email: 'user@example.com',
      tenantId: 'default',
      role: UserRole.Admin,
    };
    mockJwtService.verifyAsync.mockResolvedValueOnce(payload);
    const { context, request } = buildContext({ cookie: 'eo_session=valid-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.user).toEqual({
      userId: 'user-id',
      email: 'user@example.com',
      tenantId: 'default',
      role: UserRole.Admin,
    });
    expect(alsStore.user).toBe('user-id');
    expect(alsStore.tenant).toBe('default');
  });

  it('should accept a token carried by the eo_session cookie in a non-prod-like environment', async () => {
    const payload: JwtPayload = {
      sub: 'user-id',
      email: 'user@example.com',
      tenantId: 'default',
      role: UserRole.Admin,
    };
    mockJwtService.verifyAsync.mockResolvedValueOnce(payload);
    const { context } = buildContext({ cookie: 'eo_session=cookie-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('cookie-token');
  });

  // Single-name resolution regression: the guard used to accept both `eo_session` and
  // `__Host-eo_session` unconditionally, in every environment. That let an attacker who could
  // plant a plain `eo_session` cookie (XSS or a network position on a plain-HTTP sibling
  // subdomain) authenticate as themselves against a victim who held no `__Host-` cookie at all —
  // the guard would fall through to the plain name regardless of environment. The guard now
  // resolves exactly one accepted name per environment via `resolveSessionCookieName`, the same
  // predicate the controller uses to set the cookie.
  describe('single-name resolution', () => {
    it('should reject the plain eo_session cookie and accept __Host-eo_session in a prod-like environment', async () => {
      // Non-default tenant: production also rejects the default tenant (see "default tenant
      // rejection" below), and this test is about cookie-name resolution, not that check.
      const payload: JwtPayload = {
        sub: 'user-id',
        email: 'user@example.com',
        tenantId: 'tenant-b',
        role: UserRole.Admin,
      };
      const { guard: prodGuard } = await buildGuard(NodeEnv.PRODUCTION);

      const { context: plainContext } = buildContext({ cookie: 'eo_session=cookie-token' });
      await expect(prodGuard.canActivate(plainContext)).rejects.toThrow(UnauthorizedException);
      expect(mockJwtService.verifyAsync).not.toHaveBeenCalled();

      mockJwtService.verifyAsync.mockResolvedValueOnce(payload);
      const { context: secureContext } = buildContext({
        cookie: '__Host-eo_session=secure-cookie-token',
      });
      await expect(prodGuard.canActivate(secureContext)).resolves.toBe(true);
      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('secure-cookie-token');
    });

    it('should reject the __Host-eo_session cookie and accept the plain eo_session in a dev environment', async () => {
      const payload: JwtPayload = {
        sub: 'user-id',
        email: 'user@example.com',
        tenantId: 'default',
        role: UserRole.Admin,
      };
      const { guard: devGuard } = await buildGuard(NodeEnv.DEVELOPMENT);

      const { context: secureContext } = buildContext({
        cookie: '__Host-eo_session=secure-cookie-token',
      });
      await expect(devGuard.canActivate(secureContext)).rejects.toThrow(UnauthorizedException);
      expect(mockJwtService.verifyAsync).not.toHaveBeenCalled();

      mockJwtService.verifyAsync.mockResolvedValueOnce(payload);
      const { context: plainContext } = buildContext({ cookie: 'eo_session=cookie-token' });
      await expect(devGuard.canActivate(plainContext)).resolves.toBe(true);
      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('cookie-token');
    });
  });

  // Fail-closed regression: `DEFAULT_TENANT_ID` is the seeded demo/dev tenant. A token still
  // carrying it in a prod-like environment — stale JWT, seeded dev account, hand-crafted — must
  // not authenticate, and the rejection must be indistinguishable from any other bad token.
  describe('default tenant rejection', () => {
    const defaultTenantPayload: JwtPayload = {
      sub: 'user-id',
      email: 'user@example.com',
      tenantId: 'default',
      role: UserRole.Admin,
    };

    it('should throw UnauthorizedException for the default tenant under production', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce(defaultTenantPayload);
      const { guard: prodGuard } = await buildGuard(NodeEnv.PRODUCTION);
      const { context } = buildContext({ cookie: '__Host-eo_session=default-tenant-token' });

      await expect(prodGuard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException('Invalid or expired token'),
      );
    });

    it('should throw UnauthorizedException for the default tenant under staging', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce(defaultTenantPayload);
      const { guard: stagingGuard } = await buildGuard(NodeEnv.STAGING);
      const { context } = buildContext({ cookie: '__Host-eo_session=default-tenant-token' });

      await expect(stagingGuard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException('Invalid or expired token'),
      );
    });

    it('should accept the default tenant under a non-prod-like environment', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce(defaultTenantPayload);
      const { context } = buildContext({ cookie: 'eo_session=default-tenant-token' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should accept a non-default tenant under production and staging', async () => {
      const nonDefaultPayload: JwtPayload = {
        sub: 'user-id',
        email: 'user@example.com',
        tenantId: 'tenant-b',
        role: UserRole.Admin,
      };
      const { guard: prodGuard } = await buildGuard(NodeEnv.PRODUCTION);
      mockJwtService.verifyAsync.mockResolvedValueOnce(nonDefaultPayload);
      const { context: prodContext } = buildContext({
        cookie: '__Host-eo_session=non-default-token',
      });
      await expect(prodGuard.canActivate(prodContext)).resolves.toBe(true);

      const { guard: stagingGuard } = await buildGuard(NodeEnv.STAGING);
      mockJwtService.verifyAsync.mockResolvedValueOnce(nonDefaultPayload);
      const { context: stagingContext } = buildContext({
        cookie: '__Host-eo_session=non-default-token',
      });
      await expect(stagingGuard.canActivate(stagingContext)).resolves.toBe(true);
    });
  });

  // Regression: the guard used to read `Authorization` before the cookie, so a bearer token was a
  // live credential path independent of the cookie. The cookie is now the only source it reads —
  // this proves an Authorization header present alongside a valid cookie is ignored entirely, not
  // merely deprioritized.
  it('should ignore an Authorization header and authenticate from the cookie alone', async () => {
    const payload: JwtPayload = {
      sub: 'user-id',
      email: 'user@example.com',
      tenantId: 'default',
      role: UserRole.Admin,
    };
    mockJwtService.verifyAsync.mockResolvedValueOnce(payload);
    const { context } = buildContext({
      authorization: 'Bearer header-token',
      cookie: 'eo_session=cookie-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('cookie-token');
  });

  it('should throw UnauthorizedException when only an Authorization header is present, no cookie', async () => {
    const { context } = buildContext({ authorization: 'Bearer header-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(mockJwtService.verifyAsync).not.toHaveBeenCalled();
  });
});
