import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { ApiKey } from '../../../../src/database/schemas/administration/api-key/api-key.schema';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import { ApiKeysService } from '../../../../src/features/platform/api-keys/api-keys.service';
import { ApiKeyNotFoundException } from '../../../../src/features/platform/api-keys/exceptions/api-keys.exception';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

/** Builds a validly shaped presented token (`eo_pat_` + 43-char base64url) matching what
 *  `ApiKeysService.mint` generates, so the length/prefix precheck in `verify` passes and every
 *  test exercises the hash-lookup branches instead of bailing out on shape alone. */
const buildPresentableToken = (): string => `eo_pat_${randomBytes(32).toString('base64url')}`;

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

describe('ApiKeysService', () => {
  let service: ApiKeysService;

  const mockApiKeyModel = getMockModel();
  const mockUserModel = getMockModel();
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const apiKeyId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const actorId = userId.toString();

  const buildMockApiKey = (overrides: Record<string, unknown> = {}) => ({
    _id: apiKeyId,
    tenantId: 'tenant-a',
    userId,
    tokenHash: 'h'.repeat(64),
    tokenPrefix: 'eo_pat_abcdef',
    name: 'CI integration',
    expiresAt: undefined,
    revokedAt: undefined,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });

  const buildMockUser = (overrides: Record<string, unknown> = {}) => ({
    _id: userId,
    email: 'user@example.com',
    tenantId: 'tenant-a',
    role: UserRole.Member,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: getModelToken(ApiKey.name), useValue: mockApiKeyModel },
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ApiKeysService>(ApiKeysService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('mint', () => {
    it('should mint a key, persist only the hash, and return the plaintext token once', async () => {
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey());

      const result = await service.mint({
        name: 'CI integration',
        actorId,
        tenantId: 'tenant-a',
      });

      expect(mockApiKeyModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a', userId, name: 'CI integration' }),
      );
      const [createCall] = mockApiKeyModel.create.mock.calls[0] as [
        { tokenHash: string; tokenPrefix: string },
      ];
      expect(createCall.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(createCall.tokenHash).toBe(hashOf(result.token));
      expect(createCall.tokenPrefix.startsWith('eo_pat_')).toBe(true);
      expect(result.token.startsWith('eo_pat_')).toBe(true);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'api-keys.minted',
        actorId,
        subject: { entityType: 'ApiKey', entityId: apiKeyId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should pass an explicit expiresAt through to persistence', async () => {
      const expiresAt = new Date('2026-12-31T00:00:00.000Z');
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey({ expiresAt }));

      await service.mint({ name: 'CI integration', expiresAt, actorId, tenantId: 'tenant-a' });

      expect(mockApiKeyModel.create).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }));
    });
  });

  describe('list', () => {
    it('should list a user’s keys scoped by tenant and user, and record an audit event', async () => {
      mockApiKeyModel.find.mockResolvedValueOnce([buildMockApiKey()]);
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list(actorId, 'tenant-a');

      expect(mockApiKeyModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', userId },
        null,
        expect.objectContaining({ sort: { createdAt: -1 } }),
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'api-keys.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
      });
      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0]).not.toHaveProperty('tokenHash');
    });
  });

  describe('revoke', () => {
    it('should throw ApiKeyNotFoundException for a malformed id', async () => {
      await expect(service.revoke('not-an-id', actorId, 'tenant-a')).rejects.toBeInstanceOf(
        ApiKeyNotFoundException,
      );
      expect(mockApiKeyModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw ApiKeyNotFoundException when no key matches the user and tenant', async () => {
      mockApiKeyModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(service.revoke(apiKeyId.toString(), actorId, 'tenant-a')).rejects.toBeInstanceOf(
        ApiKeyNotFoundException,
      );
    });

    it('should set revokedAt, scoped to the owning user and tenant, and record an audit event', async () => {
      mockApiKeyModel.findOneAndUpdate.mockResolvedValueOnce(
        buildMockApiKey({ revokedAt: new Date() }),
      );

      await service.revoke(apiKeyId.toString(), actorId, 'tenant-a');

      // Recast rather than `expect.any(Date)` inside an object literal — its `any`-typed return
      // trips `no-unsafe-assignment`, same reasoning `ingestion.service.spec.ts`'s
      // `getFindOneAndUpdateCall` documents for its own identical case.
      const [revokeFilter, revokeUpdate] = mockApiKeyModel.findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $set: { revokedAt: Date } },
      ];
      expect(revokeFilter).toEqual({ _id: apiKeyId.toString(), userId, tenantId: 'tenant-a' });
      expect(revokeUpdate.$set.revokedAt).toBeInstanceOf(Date);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'api-keys.revoked',
        actorId,
        subject: { entityType: 'ApiKey', entityId: apiKeyId.toString() },
        tenantId: 'tenant-a',
      });
    });
  });

  describe('verify', () => {
    it('should refuse a token of the wrong length without touching the database', async () => {
      const result = await service.verify('eo_pat_too-short');

      expect(result).toBeNull();
      expect(mockApiKeyModel.findOne).not.toHaveBeenCalled();
    });

    it('should refuse a correctly-sized token with the wrong prefix', async () => {
      const wrongPrefixToken = `xx_pat_${randomBytes(32).toString('base64url')}`;

      const result = await service.verify(wrongPrefixToken);

      expect(result).toBeNull();
      expect(mockApiKeyModel.findOne).not.toHaveBeenCalled();
    });

    it('should refuse a well-shaped token with no matching hash', async () => {
      mockApiKeyModel.findOne.mockResolvedValueOnce(null);

      const result = await service.verify(buildPresentableToken());

      expect(result).toBeNull();
    });

    it('should refuse when the stored hash content differs despite the query match', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(buildMockApiKey({ tokenHash: 'f'.repeat(64) }));

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should refuse when the stored hash has a different length than the computed digest', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(buildMockApiKey({ tokenHash: 'short' }));

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should fail closed for a revoked key', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(
        buildMockApiKey({ tokenHash: hashOf(token), revokedAt: new Date() }),
      );

      const result = await service.verify(token);

      expect(result).toBeNull();
      expect(mockUserModel.findById).not.toHaveBeenCalled();
    });

    it('should fail closed for an expired key', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(
        buildMockApiKey({
          tokenHash: hashOf(token),
          expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      );

      const result = await service.verify(token);

      expect(result).toBeNull();
      expect(mockUserModel.findById).not.toHaveBeenCalled();
    });

    it('should fail closed when the key’s user no longer exists', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(buildMockApiKey({ tokenHash: hashOf(token) }));
      mockUserModel.findById.mockResolvedValueOnce(null);

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    it('should return an identity for a live, unexpired key belonging to an existing user', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(
        buildMockApiKey({
          tokenHash: hashOf(token),
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
      );
      mockUserModel.findById.mockResolvedValueOnce(buildMockUser());

      const result = await service.verify(token);

      expect(result).toEqual({
        userId: actorId,
        tenantId: 'tenant-a',
        role: UserRole.Member,
        email: 'user@example.com',
      });
    });

    it('should resolve role live from the User row rather than anything stored on the key', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(buildMockApiKey({ tokenHash: hashOf(token) }));
      mockUserModel.findById.mockResolvedValueOnce(buildMockUser({ role: UserRole.Admin }));

      const result = await service.verify(token);

      expect(mockUserModel.findById).toHaveBeenCalledWith(userId);
      expect(result?.role).toBe(UserRole.Admin);
    });
  });
});
