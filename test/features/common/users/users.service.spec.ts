import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import { UsersService } from '../../../../src/features/common/users/users.service';
import {
  LastAdminException,
  UserNotFoundException,
  UserRestoreFailedException,
} from '../../../../src/features/common/users/exceptions/users.exception';
import { DEFAULT_PAGINATION_LIMIT } from '../../../../src/shared/constants/pagination-defaults.constant';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel, type MockModel } from '../../../utils/get-mock-model';

describe('UsersService', () => {
  let service: UsersService;

  // `UsersService.remove`'s compensating insert bypasses Mongoose and calls the driver collection
  // directly, which `getMockModel()` does not stub — extended here rather than in the shared
  // factory since no other service uses this path yet.
  const mockUserModel = getMockModel() as MockModel & {
    collection: { insertOne: jest.Mock<Promise<unknown>, [Record<string, unknown>]> };
  };
  mockUserModel.collection = {
    insertOne: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
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
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
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
          sort: { createdAt: -1 },
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
  });

  describe('changeRole', () => {
    it('should refuse a malformed id without touching the database', async () => {
      await expect(
        service.changeRole('not-an-object-id', UserRole.Admin, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(UserNotFoundException);
      expect(mockUserModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should refuse when no member matches the id in this tenant', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.changeRole(userId.toString(), UserRole.Admin, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(UserNotFoundException);
      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
    });

    it('should change the role, scoped to the tenant, and record an audit event', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(
        buildMockUser({ role: UserRole.Member }),
      );
      mockUserModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.changeRole(
        userId.toString(),
        UserRole.Admin,
        actorId,
        'tenant-a',
      );

      expect(mockUserModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: userId.toString(), tenantId: 'tenant-a' },
        { $set: { role: UserRole.Admin } },
      );
      expect(mockUserModel.updateOne).not.toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.role-changed',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual({
        id: userId.toString(),
        email: 'colleague@example.com',
        role: UserRole.Admin,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });
    });

    it('should revert the role, audit the refusal, and refuse when the change would leave the tenant with no admin', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockUserModel.countDocuments.mockResolvedValueOnce(0);

      await expect(
        service.changeRole(userId.toString(), UserRole.Member, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(LastAdminException);

      // Compensating update restores this call's own row to the role it read before writing — the
      // guard only ran because that role was Admin, so this write can only ever add an admin back.
      expect(mockUserModel.updateOne).toHaveBeenCalledWith(
        { _id: userId.toString(), tenantId: 'tenant-a' },
        { $set: { role: UserRole.Admin } },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.role-change-refused',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
    });

    /**
     * The whole of the guard: a count taken before the write is a read a second concurrent caller
     * can invalidate before either write lands, which is exactly how two admins demoting each
     * other at once could both proceed and leave zero. Counting after the write makes each
     * caller's own row visible to its own check. Asserted as call order, mirroring
     * `ApiKeysService.assertUnderActiveKeyCap`'s own test — no mocked model can interleave two
     * calls to prove the race directly.
     */
    it('should count remaining admins only after writing an admin-reducing role change', async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockUserModel.countDocuments.mockResolvedValueOnce(1);

      await service.changeRole(userId.toString(), UserRole.Member, actorId, 'tenant-a');

      expect(mockUserModel.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        mockUserModel.countDocuments.mock.invocationCallOrder[0],
      );
    });

    /**
     * Pins Fix 1's actual invariant: the guard only runs on a write that can reduce the admin
     * count. None of these three transitions can, so each must skip the count query and the
     * compensation entirely — the defect this closes was a compensation running (and misfiring)
     * on a transition that never should have paid for one.
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

        expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
        expect(mockUserModel.updateOne).not.toHaveBeenCalled();
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
      expect(mockUserModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('should refuse when no member matches the id in this tenant', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(null);

      await expect(service.remove(userId.toString(), actorId, 'tenant-a')).rejects.toBeInstanceOf(
        UserNotFoundException,
      );
      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
    });

    it('should remove the member, scoped to the tenant, and record an audit event', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(buildMockUser());
      mockUserModel.countDocuments.mockResolvedValueOnce(1);

      await service.remove(userId.toString(), actorId, 'tenant-a');

      expect(mockUserModel.findOneAndDelete).toHaveBeenCalledWith({
        _id: userId.toString(),
        tenantId: 'tenant-a',
      });
      expect(mockUserModel.create).not.toHaveBeenCalled();
      expect(mockUserModel.collection.insertOne).not.toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.removed',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
    });

    /**
     * Pins Fix 1's invariant on the `remove` side: removing a member can never take the tenant to
     * zero admins, so the guard must skip the count query and the compensating insert entirely.
     */
    it('should skip the admin-count guard when removing a member', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(
        buildMockUser({ role: UserRole.Member }),
      );

      await service.remove(userId.toString(), actorId, 'tenant-a');

      expect(mockUserModel.countDocuments).not.toHaveBeenCalled();
      expect(mockUserModel.collection.insertOne).not.toHaveBeenCalled();
    });

    it('should re-insert the removed row unchanged, audit the refusal, and refuse when removal would leave the tenant with no admin', async () => {
      const removedUser = buildMockUser({ role: UserRole.Admin });
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(removedUser);
      mockUserModel.countDocuments.mockResolvedValueOnce(0);
      mockUserModel.collection.insertOne.mockResolvedValueOnce(undefined);

      await expect(service.remove(userId.toString(), actorId, 'tenant-a')).rejects.toBeInstanceOf(
        LastAdminException,
      );

      // Bypasses `create` — and therefore `auditablePlugin` — entirely, so the restored row keeps
      // exactly the `createdAt`/`createdBy` it had before the refused delete rather than acquiring
      // new ones stamped for the acting admin (Fix 2's regression: a refused removal must not
      // rewrite the record's provenance).
      expect(mockUserModel.create).not.toHaveBeenCalled();
      expect(mockUserModel.collection.insertOne).toHaveBeenCalledWith(removedUser.toObject());
      const restored = mockUserModel.collection.insertOne.mock.calls[0]?.[0];
      expect(restored?.createdAt).toEqual(removedUser.createdAt);
      expect(restored?.createdBy).toEqual(removedUser.createdBy);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'users.remove-refused',
        actorId,
        subject: { entityType: 'User', entityId: userId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should wrap a failed compensating insert rather than lose the removed row silently', async () => {
      const removedUser = buildMockUser({ role: UserRole.Admin });
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(removedUser);
      mockUserModel.countDocuments.mockResolvedValueOnce(0);
      const duplicateKeyError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      mockUserModel.collection.insertOne.mockRejectedValueOnce(duplicateKeyError);

      const rejection = await service
        .remove(userId.toString(), actorId, 'tenant-a')
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(UserRestoreFailedException);
      expect((rejection as UserRestoreFailedException).cause).toBe(duplicateKeyError);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    /**
     * Same shape as `changeRole`'s call-order assertion — see that test's doc comment for why this
     * ordering is what closes the race rather than a count taken before the delete.
     */
    it('should count remaining admins only after deleting an admin', async () => {
      mockUserModel.findOneAndDelete.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));
      mockUserModel.countDocuments.mockResolvedValueOnce(1);

      await service.remove(userId.toString(), actorId, 'tenant-a');

      expect(mockUserModel.findOneAndDelete.mock.invocationCallOrder[0]).toBeLessThan(
        mockUserModel.countDocuments.mock.invocationCallOrder[0],
      );
    });
  });
});
