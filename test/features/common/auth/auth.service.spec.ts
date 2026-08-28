import { BadRequestException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import type { StringValue } from 'ms';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { Tenant } from '../../../../src/database/schemas/administration/tenant/tenant.schema';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import { AuthService } from '../../../../src/features/common/auth/auth.service';
import {
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
  InvalidInvitationException,
  InvitationEmailConflictException,
} from '../../../../src/features/common/auth/exceptions/auth.exception';
import { JwtPayload } from '../../../../src/features/common/auth/types/jwt-payload.type';
import { InvitationsService } from '../../../../src/features/common/invitations/invitations.service';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockConfig } from '../../../utils/get-mock-config';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: JwtService;

  const mockUserId = '65f1c2e4a1b2c3d4e5f6a7b8';
  const mockUserModel = getMockModel();
  const mockTenantModel = getMockModel();
  const mockConfig = getMockConfig();
  const mockAuditService = { record: jest.fn() };
  const mockInvitationsService = { verify: jest.fn(), accept: jest.fn(), release: jest.fn() };

  const buildMockUser = (overrides: Record<string, unknown> = {}) => ({
    _id: { toString: () => mockUserId },
    email: 'user@example.com',
    password: 'irrelevant-placeholder-hash',
    tenantId: DEFAULT_TENANT_ID,
    role: UserRole.Member,
    tokenVersion: 3,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });

  const buildMockTenant = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 'generated-tenant-id',
    name: 'user@example.com',
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: mockConfig.auth.jwtSecret,
          signOptions: { expiresIn: mockConfig.auth.jwtExpiresIn as StringValue },
        }),
      ],
      providers: [
        AuthService,
        {
          provide: getModelToken(User.name),
          useValue: mockUserModel,
        },
        {
          provide: getModelToken(Tenant.name),
          useValue: mockTenantModel,
        },
        {
          provide: AppLogger,
          useValue: getMockLogger(),
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: InvitationsService,
          useValue: mockInvitationsService,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get<JwtService>(JwtService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('register', () => {
    it('should hash the password before storing it', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);
      mockTenantModel.create.mockImplementationOnce((doc: { tenantId: string; name: string }) =>
        Promise.resolve(buildMockTenant(doc)),
      );
      mockUserModel.create.mockImplementationOnce((doc: { email: string; password: string }) =>
        Promise.resolve(buildMockUser(doc)),
      );

      const result = await service.register({ email: 'user@example.com', password: 'password123' });

      const calls = mockUserModel.create.mock.calls as Array<[{ email: string; password: string }]>;
      const createdDoc = calls[0][0];
      expect(createdDoc.password).not.toBe('password123');
      expect(await bcrypt.compare('password123', createdDoc.password)).toBe(true);
      expect(result.id).toBe(mockUserId);
    });

    it('should lowercase the email before lookup and storage', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);
      mockTenantModel.create.mockImplementationOnce((doc: { tenantId: string; name: string }) =>
        Promise.resolve(buildMockTenant(doc)),
      );
      mockUserModel.create.mockImplementationOnce((doc: { email: string; password: string }) =>
        Promise.resolve(buildMockUser(doc)),
      );

      await service.register({ email: 'User@Example.COM', password: 'password123' });

      expect(mockUserModel.findOne).toHaveBeenCalledWith({ email: 'user@example.com' });
      const calls = mockUserModel.create.mock.calls as Array<[{ email: string; password: string }]>;
      const createdDoc = calls[0][0];
      expect(createdDoc.email).toBe('user@example.com');
    });

    it('should provision a brand-new tenant and make the registrant its admin', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);
      mockTenantModel.create.mockImplementationOnce((doc: { tenantId: string; name: string }) =>
        Promise.resolve(buildMockTenant(doc)),
      );
      mockUserModel.create.mockImplementationOnce((doc: Record<string, unknown>) =>
        Promise.resolve(buildMockUser(doc)),
      );

      const result = await service.register({ email: 'user@example.com', password: 'password123' });

      const tenantCalls = mockTenantModel.create.mock.calls as Array<
        [{ tenantId: string; name: string }]
      >;
      const userCalls = mockUserModel.create.mock.calls as Array<[Record<string, unknown>]>;
      const createdTenant = tenantCalls[0][0];
      const createdUser = userCalls[0][0];

      expect(createdTenant.name).toBe('user@example.com');
      expect(createdUser.tenantId).toBe(createdTenant.tenantId);
      expect(createdUser.role).toBe(UserRole.Admin);
      expect(result.role).toBe(UserRole.Admin);
    });

    it('should generate a different tenantId for each registration', async () => {
      mockUserModel.findOne.mockResolvedValue(null);
      mockTenantModel.create.mockImplementation((doc: { tenantId: string; name: string }) =>
        Promise.resolve(buildMockTenant(doc)),
      );
      mockUserModel.create.mockImplementation((doc: Record<string, unknown>) =>
        Promise.resolve(buildMockUser(doc)),
      );

      await service.register({ email: 'first@example.com', password: 'password123' });
      await service.register({ email: 'second@example.com', password: 'password123' });

      const tenantCalls = mockTenantModel.create.mock.calls as Array<
        [{ tenantId: string; name: string }]
      >;
      expect(tenantCalls[0][0].tenantId).not.toBe(tenantCalls[1][0].tenantId);
    });

    it('should delete the newly created tenant and rethrow when user creation fails', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);
      mockTenantModel.create.mockImplementationOnce((doc: { tenantId: string; name: string }) =>
        Promise.resolve(buildMockTenant(doc)),
      );
      const userCreationError = new Error('user creation failed');
      mockUserModel.create.mockRejectedValueOnce(userCreationError);
      mockTenantModel.deleteOne.mockResolvedValueOnce(undefined);

      const error = await service
        .register({ email: 'user@example.com', password: 'password123' })
        .catch((e: unknown) => e);

      expect(error).toBe(userCreationError);
      const tenantCalls = mockTenantModel.create.mock.calls as Array<
        [{ tenantId: string; name: string }]
      >;
      const createdTenantId = tenantCalls[0][0].tenantId;
      expect(mockTenantModel.deleteOne).toHaveBeenCalledWith({ tenantId: createdTenantId });
    });

    it('should throw EmailAlreadyRegisteredException with 409 Conflict on a duplicate email', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(buildMockUser());

      const error = await service
        .register({ email: 'user@example.com', password: 'password123' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EmailAlreadyRegisteredException);
      expect((error as EmailAlreadyRegisteredException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect(mockUserModel.create).not.toHaveBeenCalled();
      expect(mockTenantModel.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when neither email nor invitationToken is present', async () => {
      const error = await service.register({ password: 'password123' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(mockUserModel.findOne).not.toHaveBeenCalled();
    });

    describe('with an invitation token', () => {
      const invitationIdentity = {
        id: 'invitation-id',
        tenantId: 'invited-tenant-id',
        email: 'invitee@example.com',
        role: UserRole.Member,
      };

      it('should join the invitation’s tenant with its role, ignoring any submitted email, and reserve it before creating the user', async () => {
        mockInvitationsService.verify.mockResolvedValueOnce(invitationIdentity);
        mockUserModel.findOne.mockResolvedValueOnce(null);
        mockInvitationsService.accept.mockResolvedValueOnce(true);
        mockUserModel.create.mockImplementationOnce((doc: Record<string, unknown>) =>
          Promise.resolve(buildMockUser(doc)),
        );

        const result = await service.register({
          password: 'password123',
          invitationToken: 'eo_inv_token',
        });

        expect(mockInvitationsService.verify).toHaveBeenCalledWith('eo_inv_token');
        expect(mockUserModel.findOne).toHaveBeenCalledWith({ email: invitationIdentity.email });
        const [acceptedId, acceptedUserId, acceptedTenantId] = mockInvitationsService.accept.mock
          .calls[0] as [string, string, string];
        expect(acceptedId).toBe(invitationIdentity.id);
        expect(acceptedTenantId).toBe(invitationIdentity.tenantId);
        expect(acceptedUserId).toMatch(/^[0-9a-f]{24}$/);

        const [createCall] = mockUserModel.create.mock.calls[0] as [
          { _id: { toString: () => string } } & Record<string, unknown>,
        ];
        expect(createCall._id.toString()).toBe(acceptedUserId);
        expect(createCall.email).toBe(invitationIdentity.email);
        expect(createCall.tenantId).toBe(invitationIdentity.tenantId);
        expect(createCall.role).toBe(invitationIdentity.role);
        expect(mockTenantModel.create).not.toHaveBeenCalled();
        // `accept` is called (and wins) before `create`, closing the double-redemption race —
        // asserted here by ordering the calls each mock recorded.
        expect(mockInvitationsService.accept.mock.invocationCallOrder[0]).toBeLessThan(
          mockUserModel.create.mock.invocationCallOrder[0],
        );
        expect(result.role).toBe(invitationIdentity.role);
      });

      it('should throw InvalidInvitationException with 400 Bad Request for an unknown, expired, or already-used token, and never create a tenant', async () => {
        mockInvitationsService.verify.mockResolvedValueOnce(null);

        const error = await service
          .register({ password: 'password123', invitationToken: 'eo_inv_stale' })
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(InvalidInvitationException);
        expect((error as InvalidInvitationException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(mockUserModel.create).not.toHaveBeenCalled();
        expect(mockTenantModel.create).not.toHaveBeenCalled();
        expect(mockInvitationsService.accept).not.toHaveBeenCalled();
      });

      it('should throw InvitationEmailConflictException with 400 Bad Request when the invitation’s email already has an account, leaving that account untouched', async () => {
        mockInvitationsService.verify.mockResolvedValueOnce(invitationIdentity);
        mockUserModel.findOne.mockResolvedValueOnce(
          buildMockUser({ email: invitationIdentity.email }),
        );

        const error = await service
          .register({ password: 'password123', invitationToken: 'eo_inv_token' })
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(InvitationEmailConflictException);
        expect((error as InvitationEmailConflictException).getStatus()).toBe(
          HttpStatus.BAD_REQUEST,
        );
        expect(mockUserModel.create).not.toHaveBeenCalled();
        expect(mockInvitationsService.accept).not.toHaveBeenCalled();
      });

      it('should throw InvalidInvitationException with 400 Bad Request, never reaching create, when a concurrent redemption already won the reservation', async () => {
        mockInvitationsService.verify.mockResolvedValueOnce(invitationIdentity);
        mockUserModel.findOne.mockResolvedValueOnce(null);
        mockInvitationsService.accept.mockResolvedValueOnce(false);

        const error = await service
          .register({ password: 'password123', invitationToken: 'eo_inv_token' })
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(InvalidInvitationException);
        expect((error as InvalidInvitationException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(mockUserModel.create).not.toHaveBeenCalled();
        expect(mockInvitationsService.release).not.toHaveBeenCalled();
      });

      it('should release the reservation and rethrow when user creation fails for an unrelated reason', async () => {
        mockInvitationsService.verify.mockResolvedValueOnce(invitationIdentity);
        mockUserModel.findOne.mockResolvedValueOnce(null);
        mockInvitationsService.accept.mockResolvedValueOnce(true);
        const userCreationError = new Error('user creation failed');
        mockUserModel.create.mockRejectedValueOnce(userCreationError);
        mockInvitationsService.release.mockResolvedValueOnce(undefined);

        const error = await service
          .register({ password: 'password123', invitationToken: 'eo_inv_token' })
          .catch((e: unknown) => e);

        expect(error).toBe(userCreationError);
        expect(mockInvitationsService.release).toHaveBeenCalledWith(
          invitationIdentity.id,
          invitationIdentity.tenantId,
        );
      });
    });
  });

  describe('login', () => {
    it('should throw a generic 401 for an unknown email after exercising the dummy-hash compare', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);

      const error = await service
        .login({ email: 'unknown@example.com', password: 'password123' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InvalidCredentialsException);
      expect((error as InvalidCredentialsException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect((error as InvalidCredentialsException).message).toBe('Invalid email or password');
    });

    it('should throw a generic 401 when the password does not match', async () => {
      const storedHash = await bcrypt.hash('correct-password', 12);
      mockUserModel.findOne.mockResolvedValueOnce(buildMockUser({ password: storedHash }));

      const error = await service
        .login({ email: 'user@example.com', password: 'wrong-password' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InvalidCredentialsException);
      expect((error as InvalidCredentialsException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect((error as InvalidCredentialsException).message).toBe('Invalid email or password');
    });

    it('should return an accessToken carrying sub+email+tenantId+role+tokenVersion and the mapped user on success', async () => {
      const storedHash = await bcrypt.hash('correct-password', 12);
      mockUserModel.findOne.mockResolvedValueOnce(buildMockUser({ password: storedHash }));

      const result = await service.login({
        email: 'user@example.com',
        password: 'correct-password',
      });

      const decoded = jwtService.verify<JwtPayload & { iat: number; exp: number }>(
        result.accessToken,
      );
      expect(decoded.sub).toBe(mockUserId);
      expect(decoded.email).toBe('user@example.com');
      expect(decoded.tenantId).toBe(DEFAULT_TENANT_ID);
      expect(decoded.role).toBe(UserRole.Member);
      // Read from the row, not defaulted: a hardcoded 0 here would mint a token the guard accepts
      // for an account whose epoch has already been raised to revoke it.
      expect(decoded.tokenVersion).toBe(3);
      // Exact-key assertion: a claim the guard never learned to compare is a claim that survives
      // its own revocation, so a new one reds the mutation-class sweep in `auth.e2e-spec.ts` here
      // first.
      expect(Object.keys(decoded).sort()).toEqual(
        ['sub', 'email', 'tenantId', 'role', 'tokenVersion', 'iat', 'exp'].sort(),
      );
      expect(result.user.id).toBe(mockUserId);
      expect(result.user.email).toBe('user@example.com');
      expect(result.user.role).toBe(UserRole.Member);
    });
  });

  describe('me', () => {
    it('should return the mapped user when found', async () => {
      mockUserModel.findById.mockResolvedValueOnce(buildMockUser());

      const result = await service.me(mockUserId);

      expect(mockUserModel.findById).toHaveBeenCalledWith(mockUserId);
      expect(result.id).toBe(mockUserId);
      expect(result.email).toBe('user@example.com');
    });

    it('should throw UnauthorizedException when the user is not found', async () => {
      mockUserModel.findById.mockResolvedValueOnce(null);

      await expect(service.me(mockUserId)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('should record an auth.logout audit event for the given user and tenant', async () => {
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.logout(mockUserId, DEFAULT_TENANT_ID);

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'auth.logout',
        actorId: mockUserId,
        subject: { entityType: 'User', entityId: mockUserId },
        tenantId: DEFAULT_TENANT_ID,
      });
    });
  });
});
