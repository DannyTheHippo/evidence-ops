import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { Invitation } from '../../../../src/database/schemas/administration/invitation/invitation.schema';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import {
  InvitationsService,
  INVITATION_TTL_DAYS,
} from '../../../../src/features/common/invitations/invitations.service';
import {
  InvitationEmailAlreadyRegisteredException,
  InvitationNotFoundException,
} from '../../../../src/features/common/invitations/exceptions/invitations.exception';
import { DEFAULT_PAGINATION_LIMIT } from '../../../../src/shared/constants/pagination-defaults.constant';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

/** Builds a validly shaped presented token (`eo_inv_` + 43-char base64url) matching what
 *  `InvitationsService.mint` generates, so the length/prefix precheck in `verify` passes and
 *  every test exercises the hash-lookup branches instead of bailing out on shape alone. */
const buildPresentableToken = (): string => `eo_inv_${randomBytes(32).toString('base64url')}`;

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

describe('InvitationsService', () => {
  let service: InvitationsService;

  const mockInvitationModel = getMockModel();
  const mockUserModel = getMockModel();
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const invitationId = new Types.ObjectId();
  const actorId = new Types.ObjectId().toString();

  const buildMockInvitation = (overrides: Record<string, unknown> = {}) => ({
    _id: invitationId,
    tenantId: 'tenant-a',
    email: 'colleague@example.com',
    role: UserRole.Member,
    tokenHash: 'h'.repeat(64),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    acceptedAt: undefined,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: getModelToken(Invitation.name), useValue: mockInvitationModel },
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<InvitationsService>(InvitationsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('mint', () => {
    it('should mint an invitation, persist only the hash, and return the plaintext token once', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);
      mockInvitationModel.create.mockResolvedValueOnce(buildMockInvitation());

      const result = await service.mint({
        email: 'Colleague@Example.com',
        role: UserRole.Member,
        actorId,
        tenantId: 'tenant-a',
      });

      expect(mockUserModel.findOne).toHaveBeenCalledWith({ email: 'colleague@example.com' });
      expect(mockInvitationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          email: 'colleague@example.com',
          role: UserRole.Member,
        }),
      );
      const [createCall] = mockInvitationModel.create.mock.calls[0] as [{ tokenHash: string }];
      expect(createCall.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(createCall.tokenHash).toBe(hashOf(result.token));
      expect(result.token.startsWith('eo_inv_')).toBe(true);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'invitations.minted',
        actorId,
        subject: { entityType: 'Invitation', entityId: invitationId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should default expiresAt to the fixed TTL window', async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);
      mockInvitationModel.create.mockResolvedValueOnce(buildMockInvitation());

      await service.mint({
        email: 'colleague@example.com',
        role: UserRole.Member,
        actorId,
        tenantId: 'tenant-a',
      });

      const [createCall] = mockInvitationModel.create.mock.calls[0] as [{ expiresAt: Date }];
      const expectedMs = Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;
      expect(Math.abs(createCall.expiresAt.getTime() - expectedMs)).toBeLessThan(5000);
    });

    it('should refuse minting for an email that already has an account', async () => {
      mockUserModel.findOne.mockResolvedValueOnce({ email: 'colleague@example.com' });

      await expect(
        service.mint({
          email: 'colleague@example.com',
          role: UserRole.Member,
          actorId,
          tenantId: 'tenant-a',
        }),
      ).rejects.toBeInstanceOf(InvitationEmailAlreadyRegisteredException);
      expect(mockInvitationModel.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should list a tenant’s invitations and record an audit event', async () => {
      mockInvitationModel.find.mockResolvedValueOnce([buildMockInvitation()]);
      mockInvitationModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list(
        { skip: 0, limit: DEFAULT_PAGINATION_LIMIT },
        actorId,
        'tenant-a',
      );

      expect(mockInvitationModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        null,
        expect.objectContaining({
          sort: { createdAt: -1 },
          skip: 0,
          limit: DEFAULT_PAGINATION_LIMIT,
        }),
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'invitations.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
      });
      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0]).not.toHaveProperty('tokenHash');
    });

    it('should page results using the given skip and limit', async () => {
      mockInvitationModel.find.mockResolvedValueOnce([buildMockInvitation()]);
      mockInvitationModel.countDocuments.mockResolvedValueOnce(5);

      const result = await service.list({ skip: 2, limit: 1 }, actorId, 'tenant-a');

      expect(mockInvitationModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        null,
        expect.objectContaining({ skip: 2, limit: 1 }),
      );
      expect(result.count).toBe(5);
    });

    it.each([
      ['email', 'asc', { email: 1 }],
      ['expiresAt', 'desc', { expiresAt: -1 }],
      ['role', 'asc', { role: 1 }],
    ] as const)(
      'should sort by the caller-supplied %s field and %s direction',
      async (sort, sortDir, expectedSort) => {
        mockInvitationModel.find.mockResolvedValueOnce([]);
        mockInvitationModel.countDocuments.mockResolvedValueOnce(0);

        await service.list({ skip: 0, limit: 20, sort, sortDir }, actorId, 'tenant-a');

        expect(mockInvitationModel.find).toHaveBeenCalledWith(
          { tenantId: 'tenant-a' },
          null,
          expect.objectContaining({ sort: expectedSort }),
        );
      },
    );

    it('should expose acceptedAt on a redeemed invitation', async () => {
      const acceptedAt = new Date('2026-07-02T00:00:00.000Z');
      mockInvitationModel.find.mockResolvedValueOnce([buildMockInvitation({ acceptedAt })]);
      mockInvitationModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list(
        { skip: 0, limit: DEFAULT_PAGINATION_LIMIT },
        actorId,
        'tenant-a',
      );

      expect(result.docs[0].acceptedAt).toBe(acceptedAt);
    });

    it('should expose revokedAt on a revoked invitation, rather than filtering it out of the list', async () => {
      const revokedAt = new Date('2026-07-03T00:00:00.000Z');
      mockInvitationModel.find.mockResolvedValueOnce([buildMockInvitation({ revokedAt })]);
      mockInvitationModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list(
        { skip: 0, limit: DEFAULT_PAGINATION_LIMIT },
        actorId,
        'tenant-a',
      );

      expect(mockInvitationModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        null,
        expect.objectContaining({ skip: 0, limit: DEFAULT_PAGINATION_LIMIT }),
      );
      expect(result.docs[0].revokedAt).toBe(revokedAt);
    });
  });

  describe('verify', () => {
    it('should refuse a token of the wrong length without touching the database', async () => {
      const result = await service.verify('eo_inv_too-short');

      expect(result).toBeNull();
      expect(mockInvitationModel.findOne).not.toHaveBeenCalled();
    });

    it('should refuse a correctly-sized token with the wrong prefix', async () => {
      const wrongPrefixToken = `xx_inv_${randomBytes(32).toString('base64url')}`;

      const result = await service.verify(wrongPrefixToken);

      expect(result).toBeNull();
      expect(mockInvitationModel.findOne).not.toHaveBeenCalled();
    });

    it('should refuse a well-shaped token with no matching hash', async () => {
      mockInvitationModel.findOne.mockResolvedValueOnce(null);

      const result = await service.verify(buildPresentableToken());

      expect(result).toBeNull();
    });

    it('should refuse when the stored hash content differs despite the query match', async () => {
      const token = buildPresentableToken();
      mockInvitationModel.findOne.mockResolvedValueOnce(
        buildMockInvitation({ tokenHash: 'f'.repeat(64) }),
      );

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should refuse when the stored hash has a different length than the computed digest', async () => {
      const token = buildPresentableToken();
      mockInvitationModel.findOne.mockResolvedValueOnce(
        buildMockInvitation({ tokenHash: 'short' }),
      );

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should fail closed for an already-redeemed invitation', async () => {
      const token = buildPresentableToken();
      mockInvitationModel.findOne.mockResolvedValueOnce(
        buildMockInvitation({ tokenHash: hashOf(token), acceptedAt: new Date() }),
      );

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should fail closed for a revoked invitation', async () => {
      const token = buildPresentableToken();
      mockInvitationModel.findOne.mockResolvedValueOnce(
        buildMockInvitation({ tokenHash: hashOf(token), revokedAt: new Date() }),
      );

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should fail closed for an expired invitation', async () => {
      const token = buildPresentableToken();
      mockInvitationModel.findOne.mockResolvedValueOnce(
        buildMockInvitation({
          tokenHash: hashOf(token),
          expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      );

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should return the invitation identity for a live, unexpired, unredeemed token', async () => {
      const token = buildPresentableToken();
      mockInvitationModel.findOne.mockResolvedValueOnce(
        buildMockInvitation({ tokenHash: hashOf(token) }),
      );

      const result = await service.verify(token);

      expect(result).toEqual({
        id: invitationId.toString(),
        tenantId: 'tenant-a',
        email: 'colleague@example.com',
        role: UserRole.Member,
      });
    });
  });

  describe('accept', () => {
    it('should atomically reserve a pending invitation, scoped to its tenant, and record an audit event attributed to the joining user', async () => {
      mockInvitationModel.findOneAndUpdate.mockResolvedValueOnce(buildMockInvitation());
      const userId = new Types.ObjectId().toString();

      const result = await service.accept(invitationId.toString(), userId, 'tenant-a');

      expect(result).toBe(true);
      expect(mockInvitationModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: invitationId.toString(),
          tenantId: 'tenant-a',
          acceptedAt: { $exists: false },
          revokedAt: { $exists: false },
        },
        { $set: { acceptedAt: expect.any(Date) as Date } },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'invitations.accepted',
        actorId: userId,
        subject: { entityType: 'Invitation', entityId: invitationId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should refuse and skip the audit event when the invitation is already accepted, foreign-tenant, or unrecognized', async () => {
      mockInvitationModel.findOneAndUpdate.mockResolvedValueOnce(null);
      const userId = new Types.ObjectId().toString();

      const result = await service.accept(invitationId.toString(), userId, 'tenant-a');

      expect(result).toBe(false);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  describe('release', () => {
    it('should unset acceptedAt, scoped to the invitation’s tenant, reopening a reservation accept made', async () => {
      mockInvitationModel.updateOne.mockResolvedValueOnce({ acknowledged: true });

      await service.release(invitationId.toString(), 'tenant-a');

      expect(mockInvitationModel.updateOne).toHaveBeenCalledWith(
        { _id: invitationId.toString(), tenantId: 'tenant-a' },
        { $unset: { acceptedAt: '' } },
      );
    });
  });

  describe('revoke', () => {
    it('should refuse a malformed invitation id without touching the database', async () => {
      await expect(service.revoke('not-an-object-id', actorId, 'tenant-a')).rejects.toBeInstanceOf(
        InvitationNotFoundException,
      );
      expect(mockInvitationModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should refuse a missing, foreign-tenant, or already-accepted invitation with the same not-found message', async () => {
      mockInvitationModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.revoke(invitationId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(InvitationNotFoundException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should mark a pending invitation revoked, scoped to its tenant, and record an audit event', async () => {
      mockInvitationModel.findOneAndUpdate.mockResolvedValueOnce(buildMockInvitation());

      await service.revoke(invitationId.toString(), actorId, 'tenant-a');

      expect(mockInvitationModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: invitationId.toString(), tenantId: 'tenant-a', acceptedAt: { $exists: false } },
        { $set: { revokedAt: expect.any(Date) as Date } },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'invitations.revoked',
        actorId,
        subject: { entityType: 'Invitation', entityId: invitationId.toString() },
        tenantId: 'tenant-a',
      });
    });
  });

  describe('resend', () => {
    it('should refuse a malformed invitation id without touching the database', async () => {
      await expect(service.resend('not-an-object-id', actorId, 'tenant-a')).rejects.toBeInstanceOf(
        InvitationNotFoundException,
      );
      expect(mockInvitationModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should refuse a missing, foreign-tenant, already-accepted, or already-revoked invitation with the same not-found message', async () => {
      mockInvitationModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.resend(invitationId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(InvitationNotFoundException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should rotate the token for a pending, live invitation and record an audit event', async () => {
      mockInvitationModel.findOneAndUpdate.mockResolvedValueOnce(buildMockInvitation());

      const result = await service.resend(invitationId.toString(), actorId, 'tenant-a');

      expect(mockInvitationModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: invitationId.toString(),
          tenantId: 'tenant-a',
          acceptedAt: { $exists: false },
          revokedAt: { $exists: false },
        },
        { $set: { tokenHash: expect.any(String) as string, expiresAt: expect.any(Date) as Date } },
      );
      expect(result.token.startsWith('eo_inv_')).toBe(true);
      expect(result.email).toBe('colleague@example.com');
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'invitations.resent',
        actorId,
        subject: { entityType: 'Invitation', entityId: invitationId.toString() },
        tenantId: 'tenant-a',
      });
    });
  });
});
