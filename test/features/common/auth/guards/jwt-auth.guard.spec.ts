import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { JwtAuthGuard } from '../../../../../src/features/common/auth/guards/jwt-auth.guard';
import { JwtPayload } from '../../../../../src/features/common/auth/types/jwt-payload.type';
import { UserRole } from '../../../../../src/shared/enums/user-role.enum';
import { AlsContext } from '../../../../../src/shared/types/als-context.type';
import { AuthenticatedRequest } from '../../../../../src/shared/types/authenticated-request.type';

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

  beforeEach(async () => {
    alsStore = { 'correlation-id': 'test-correlation-id' };
    mockAls.getStore.mockReturnValue(alsStore);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: JwtService, useValue: mockJwtService },
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn().mockReturnValue(false) } },
        { provide: AsyncLocalStorage, useValue: mockAls },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
    reflector = module.get(Reflector);
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

  it('should throw UnauthorizedException when neither an Authorization header nor a cookie is present', async () => {
    const { context } = buildContext();

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when the token fails verification', async () => {
    mockJwtService.verifyAsync.mockRejectedValueOnce(new Error('bad signature'));
    const { context } = buildContext({ authorization: 'Bearer some-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  // Fail-closed regression: a token signed before tenancy landed verifies fine (same secret,
  // not expired) but carries no tenantId, and must still be rejected rather than treated as
  // tenant-less.
  it('should throw UnauthorizedException when the payload is missing tenantId', async () => {
    const legacyPayload = { sub: 'user-id', email: 'user@example.com', role: UserRole.Member };
    mockJwtService.verifyAsync.mockResolvedValueOnce(legacyPayload);
    const { context } = buildContext({ authorization: 'Bearer legacy-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when the payload is missing role', async () => {
    const legacyPayload = { sub: 'user-id', email: 'user@example.com', tenantId: 'default' };
    mockJwtService.verifyAsync.mockResolvedValueOnce(legacyPayload);
    const { context } = buildContext({ authorization: 'Bearer legacy-token' });

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
    const { context, request } = buildContext({ authorization: 'Bearer valid-token' });

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

  it('should accept a token carried only by the eo_session cookie', async () => {
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

  // Prod-like login sets `__Host-eo_session` instead of `eo_session` (see auth.controller.ts);
  // the guard must accept either name without knowing which environment issued the cookie.
  it('should accept a token carried only by the __Host-eo_session cookie', async () => {
    const payload: JwtPayload = {
      sub: 'user-id',
      email: 'user@example.com',
      tenantId: 'default',
      role: UserRole.Admin,
    };
    mockJwtService.verifyAsync.mockResolvedValueOnce(payload);
    const { context } = buildContext({ cookie: '__Host-eo_session=secure-cookie-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('secure-cookie-token');
  });

  // Dual-accept precedence: a scripted client sending both should not be able to shadow the
  // Bearer token with a stale or attacker-supplied cookie.
  it('should prefer the Authorization header over the cookie when both are present', async () => {
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
    expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('header-token');
  });
});
