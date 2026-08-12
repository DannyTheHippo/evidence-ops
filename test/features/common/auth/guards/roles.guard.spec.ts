import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { RolesGuard } from '../../../../../src/features/common/auth/guards/roles.guard';
import { UserRole } from '../../../../../src/shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../../../src/shared/types/authenticated-request.type';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  const buildContext = (
    user?: Partial<AuthenticatedRequest['user']>,
  ): { context: ExecutionContext; request: Partial<AuthenticatedRequest> } => {
    const request: Partial<AuthenticatedRequest> = { user: user as AuthenticatedRequest['user'] };
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    return { context, request };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        {
          provide: Reflector,
          useValue: { getAllAndOverride: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    guard = module.get(RolesGuard);
    reflector = module.get(Reflector);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should allow when no role metadata is present', () => {
    const { context } = buildContext({ role: UserRole.Member });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow when the user role is in the required set', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([UserRole.Admin]);
    const { context } = buildContext({ role: UserRole.Admin });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException when the user role does not match', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([UserRole.Admin]);
    const { context } = buildContext({ role: UserRole.Member });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when request.user is absent', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([UserRole.Admin]);
    const { context } = buildContext(undefined);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // Fail-closed regression: a role value outside the enum must not pass by accident — membership
  // is checked explicitly rather than by negating a mismatch, so a malformed truthy value cannot
  // slip through.
  it('should throw ForbiddenException when the role value is not a recognized enum member', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([UserRole.Admin]);
    const { context } = buildContext({ role: 'superuser' as UserRole });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
