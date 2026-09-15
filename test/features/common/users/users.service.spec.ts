import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Tenant } from '../../../../src/database/schemas/administration/tenant/tenant.schema';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import { UsersService } from '../../../../src/features/common/users/users.service';
import {
  AdminGuardUnavailableException,
  LastAdminException,
  SelfRemovalException,
  UserNotFoundException,
} from '../../../../src/features/common/users/exceptions/users.exception';
import { DEFAULT_PAGINATION_LIMIT } from '../../../../src/shared/constants/pagination-defaults.constant';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('UsersService', () => {
  let service: UsersService;

  const mockUserModel = getMockModel();
  const mockTenantModel = getMockModel();
  // Stands in for a real `ClientSession`: `withTransaction` runs its callback once and resolves to
  // whatever it returns, the same shape a caller sees when nothing forces a retry. Tests that care
  // about the guard's fail-closed branch override `mockTenantModel.updateOne` instead of this.
  const mockSession = {
    withTransaction: jest.fn<Promise<unknown>, [() => Promise<unknown>]>(),
    endSession: jest.fn<Promise<void>, []>(),
  };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const userId = new Types.ObjectId();
  const actorId = new Types.ObjectId().toString();

  const buildMockUser = (overrides: Record<string, unknown> = {}) => {
    const user = {
      _id: userId,
      tenantId: 'tenant-a',
      email: 'colleague@example.com',
      password: 'hashed-password',
      role: UserRole.Member,
      tokenVersion: 0,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      createdBy: new Types.ObjectId(),
      ...overrides,
    };
    return { ...user, toObject: jest.fn().mockReturnValue(user) };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: getModelToken(Tenant.name), useValue: mockTenantModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);

    mockUserModel.startSession.mockResolvedValue(mockSession);
    mockSession.withTransaction.mockImplementation(
      async (fn: () => Promise<unknown>) => await fn(),
    );
    mockSession.endSession.mockResolvedValue(undefined);
    mockTenantModel.updateOne.mockResolvedValue({ matchedCount: 1 });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('list', () => {
    it('should list a tenant’s members and record an audit event', async () => {
      mockUserModel.find.mockResolvedValueOnce([buildMockUser()]);
      mockUserModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list(
        { skip: 0, limit: DEFAULT_PAGINATION_LIMIT },
        actorId,
        'tenant-a',
      );

      expect(mockUserModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        null,
        expect.objectContaining({
          sort: { email: 1 },
          skip: 0,
          limit: DEFAULT_PAGINATION_LIMIT,
        }),
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
      });
      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0]).not.toHaveProperty('password');
      expect(result.docs[0]).not.toHaveProperty('tokenVersion');
    });

    it('should page results using the given skip and limit', async () => {
      mockUserModel.find.mockResolvedValueOnce([buildMockUser()]);
      mockUserModel.countDocuments.mockResolvedValueOnce(5);

      const result = await service.list({ skip: 2, limit: 1 }, actorId, 'tenant-a');

      expect(mockUserModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        null,
        expect.objectContaining({ skip: 2, limit: 1 }),
      );
      expect(result.count).toBe(5);
    });

    it.each([
      ['createdAt', 'asc', { createdAt: 1 }],
      ['role', 'desc', { role: -1 }],
    ] as const)(
      'should sort by the caller-supplied %s field and %s direction',
      async (sort, sortDir, expectedSort) => {
        mockUserModel.find.mockResolvedValueOnce([buildMockUser()]);
        mockUserModel.countDocuments.mockResolvedValueOnce(1);

        await service.list({ skip: 0, limit: 20, sort, sortDir }, actorId, 'tenant-a');

        expect(mockUserModel.find).toHaveBeenCalledWith(
          { tenantId: 'tenant-a' },
          null,
          expect.objectContaining({ sort: expectedSort }),
        );
      },
    );
  });

  describe('changeRole', () => {
    it('should refuse a malformed id without touching the database', async () => {
      await expect(
        service.changeRole('not-an-object-id', UserRole.Admin, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(UserNotFoundException);
      expect(mockUserModel.startSession).not.toHaveBeenCalled();
      expect(mockUserModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should refuse when no member matches the id in this tenant', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.changeRole(userId.toString(), UserRole.Admin, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(UserNotFoundException);
      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('should change the role, scoped to the tenant, inside the guarded transaction, and record an audit event', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(
        buildMockUser({ role: UserRole.Member }),
      );

      const result = await service.changeRole(
        userId.toString(),
        UserRole.Admin,
        actorId,
        'tenant-a',
      );

      expect(mockUserModel.startSession).toHaveBeenCalled();
      expect(mockUserModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: userId.toString(), tenantId: 'tenant-a' },
        { $set: { role: UserRole.Admin } },
        { session: mockSession },
      );
      expect(mockTenantModel.updateOne).not.toHaveBeenCalled();
      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.role-changed',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
      expect(mockSession.endSession).toHaveBeenCalled();
      expect(result).toEqual({
        id: userId.toString(),
        email: 'colleague@example.com',
        role: UserRole.Admin,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });
    });

    it('should touch the admin-guard marker, audit the refusal, and refuse when the change would leave the tenant with no admin', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockUserModel.countDocuments.mockResolvedValueOnce(0);

      await expect(
        service.changeRole(userId.toString(), UserRole.Member, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(LastAdminException);

      expect(mockTenantModel.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        { $inc: { adminGuardEpoch: 1 } },
        { session: mockSession },
      );
      expect(mockUserModel.countDocuments).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', role: UserRole.Admin },
        { session: mockSession },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.role-change-refused',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('should refuse with AdminGuardUnavailableException, and not audit a refusal, when the tenant has no registry row to guard against', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockTenantModel.updateOne.mockResolvedValueOnce({ matchedCount: 0 });

      await expect(
        service.changeRole(userId.toString(), UserRole.Member, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(AdminGuardUnavailableException);

      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    /**
     * The whole of the guard: writing, touching the shared tenant marker, and counting all run
     * inside one transaction, in that order — the marker touch is what forces a concurrent guarded
     * write in the same tenant to abort and retry against committed state rather than racing to a
     * shared zero-admin outcome, and it has to land before the count for that retry to see it.
     * Asserted as call order, since no mocked model can interleave two real transactions to prove
     * the write conflict directly.
     */
    it('should touch the admin-guard marker and count remaining admins only after writing an admin-reducing role change', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockUserModel.countDocuments.mockResolvedValueOnce(1);

      await service.changeRole(userId.toString(), UserRole.Member, actorId, 'tenant-a');

      expect(mockUserModel.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        mockTenantModel.updateOne.mock.invocationCallOrder[0],
      );
      expect(mockTenantModel.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
        mockUserModel.countDocuments.mock.invocationCallOrder[0],
      );
    });

    /**
     * Pins the guard's actual invariant: it only runs on a write that can reduce the admin count.
     * None of these three transitions can, so each must skip the marker touch and the count
     * entirely.
     */
    it.each([
      ['admin→admin', UserRole.Admin, UserRole.Admin],
      ['member→admin', UserRole.Member, UserRole.Admin],
      ['member→member', UserRole.Member, UserRole.Member],
    ])(
      'should skip the admin-count guard on a %s role change',
      async (_label, previousRole, targetRole) => {
        mockUserModel.findOneAndUpdate.mockResolvedValueOnce(buildMockUser({ role: previousRole }));

        const result = await service.changeRole(userId.toString(), targetRole, actorId, 'tenant-a');

        expect(mockTenantModel.updateOne).not.toHaveBeenCalled();
        expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
        expect(mockAuditService.record).toHaveBeenCalledWith({
          action: 'users.role-changed',
          actorId,
          subject: { entityType: 'User', entityId: userId.toString() },
          tenantId: 'tenant-a',
        });
        expect(result.role).toBe(targetRole);
      },
    );
  });

  describe('remove', () => {
    it('should refuse a malformed id without touching the database', async () => {
      await expect(service.remove('not-an-object-id', actorId, 'tenant-a')).rejects.toBeInstanceOf(
        UserNotFoundException,
      );
      expect(mockUserModel.startSession).not.toHaveBeenCalled();
      expect(mockUserModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it.each([
      ['lowercase', userId.toString()],
      ['uppercase', userId.toString().toUpperCase()],
    ])(
      'should refuse a caller removing themselves by %s hex id without opening a session or auditing',
      async (_label, id) => {
        await expect(service.remove(id, userId.toString(), 'tenant-a')).rejects.toBeInstanceOf(
          SelfRemovalException,
        );
        expect(mockUserModel.startSession).not.toHaveBeenCalled();
        expect(mockUserModel.findOneAndDelete).not.toHaveBeenCalled();
        expect(mockAuditService.record).not.toHaveBeenCalled();
      },
    );

    it('should refuse when no member matches the id in this tenant', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(null);

      await expect(service.remove(userId.toString(), actorId, 'tenant-a')).rejects.toBeInstanceOf(
        UserNotFoundException,
      );
      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('should remove the member, scoped to the tenant, inside the guarded transaction, and record an audit event', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(buildMockUser());

      await service.remove(userId.toString(), actorId, 'tenant-a');

      expect(mockUserModel.startSession).toHaveBeenCalled();
      expect(mockUserModel.findOneAndDelete).toHaveBeenCalledWith(
        { _id: userId.toString(), tenantId: 'tenant-a' },
        { session: mockSession },
      );
      expect(mockTenantModel.updateOne).not.toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.removed',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    /**
     * Pins the guard's invariant on the `remove` side: removing a member can never take the tenant
     * to zero admins, so the guard must skip the marker touch and the count entirely.
     */
    it('should skip the admin-count guard when removing a member', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(
        buildMockUser({ role: UserRole.Member }),
      );

      await service.remove(userId.toString(), actorId, 'tenant-a');

      expect(mockTenantModel.updateOne).not.toHaveBeenCalled();
      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
    });

    it('should touch the admin-guard marker, audit the refusal, and refuse when removal would leave the tenant with no admin', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockUserModel.countDocuments.mockResolvedValueOnce(0);

      await expect(service.remove(userId.toString(), actorId, 'tenant-a')).rejects.toBeInstanceOf(
        LastAdminException,
      );

      // The delete shares the aborted transaction, so it never commits — there is nothing to
      // restore, unlike a compensating write issued after an unconditional delete would need.
      expect(mockTenantModel.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        { $inc: { adminGuardEpoch: 1 } },
        { session: mockSession },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.remove-refused',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('should refuse with AdminGuardUnavailableException, and not audit a refusal, when the tenant has no registry row to guard against', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockTenantModel.updateOne.mockResolvedValueOnce({ matchedCount: 0 });

      await expect(service.remove(userId.toString(), actorId, 'tenant-a')).rejects.toBeInstanceOf(
        AdminGuardUnavailableException,
      );

      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    /**
     * Same shape as `changeRole`'s call-order assertion — see that test's doc comment for why this
     * ordering, not just the transaction boundary, is what closes the durability gap.
     */
    it('should touch the admin-guard marker and count remaining admins only after deleting an admin', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockUserModel.countDocuments.mockResolvedValueOnce(1);

      await service.remove(userId.toString(), actorId, 'tenant-a');

      expect(mockUserModel.findOneAndDelete.mock.invocationCallOrder[0]).toBeLessThan(
        mockTenantModel.updateOne.mock.invocationCallOrder[0],
      );
      expect(mockTenantModel.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
        mockUserModel.countDocuments.mock.invocationCallOrder[0],
      );
    });
  });

  describe('revokeSessions', () => {
    it('should refuse a malformed id without touching the database', async () => {
      await expect(
        service.revokeSessions('not-an-object-id', actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(UserNotFoundException);
      expect(mockUserModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should refuse when no member matches the id in this tenant', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.revokeSessions(userId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(UserNotFoundException);
    });

    it('should raise the epoch by an increment, scoped to the tenant, and record an audit event', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(buildMockUser({ tokenVersion: 1 }));

      const result = await service.revokeSessions(userId.toString(), actorId, 'tenant-a');

      expect(mockUserModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: userId.toString(), tenantId: 'tenant-a' },
        { $inc: { tokenVersion: 1 } },
        { returnDocument: 'after' },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.sessions-revoked',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual({
        id: userId.toString(),
        email: 'colleague@example.com',
        role: UserRole.Member,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });
    });
  });
});
