import { UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { ApiKey } from '../../../../src/database/schemas/administration/api-key/api-key.schema';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import {
  ApiKeysService,
  MAX_ACTIVE_KEYS_PER_USER,
} from '../../../../src/features/platform/api-keys/api-keys.service';
import {
  ApiKeyLimitExceededException,
  ApiKeyNotFoundException,
} from '../../../../src/features/platform/api-keys/exceptions/api-keys.exception';
import { DEFAULT_PAGINATION_LIMIT } from '../../../../src/shared/constants/pagination-defaults.constant';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

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
    lastUsedAt: undefined,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    tokenVersion: 0,
    ...overrides,
  });

  const buildMockUser = (overrides: Record<string, unknown> = {}) => ({
    _id: userId,
    email: 'user@example.com',
    tenantId: 'tenant-a',
    role: UserRole.Member,
    tokenVersion: 0,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: getModelToken(ApiKey.name), useValue: mockApiKeyModel },
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: TypedConfigService, useValue: getMockTypedConfig() },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ApiKeysService>(ApiKeysService);
    // `mint` reads the caller's row for the session epoch it stamps onto the key. Set as the
    // fallback so the cases that care about a specific row still queue their own with
    // `mockResolvedValueOnce`, which takes precedence.
    mockUserModel.findById.mockResolvedValue(buildMockUser());
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('mint', () => {
    it('should mint a key, persist only the hash, and return the plaintext token once', async () => {
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(0);
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
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(0);
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey({ expiresAt }));

      await service.mint({ name: 'CI integration', expiresAt, actorId, tenantId: 'tenant-a' });

      expect(mockApiKeyModel.create).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }));
    });

    it('should default expiresAt from config when omitted', async () => {
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(0);
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey());

      await service.mint({ name: 'CI integration', actorId, tenantId: 'tenant-a' });

      const [createCall] = mockApiKeyModel.create.mock.calls[0] as [{ expiresAt: Date }];
      const expectedMs = Date.now() + 90 * 24 * 60 * 60 * 1000;
      expect(Math.abs(createCall.expiresAt.getTime() - expectedMs)).toBeLessThan(5000);
    });

    it('should refuse minting, and remove the row it just wrote, once the caller is over the cap', async () => {
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey());
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(MAX_ACTIVE_KEYS_PER_USER + 1);

      await expect(
        service.mint({ name: 'One too many', actorId, tenantId: 'tenant-a' }),
      ).rejects.toBeInstanceOf(ApiKeyLimitExceededException);
      // Compensating delete names this call's own row, so a refusal cannot take a concurrent
      // mint's key with it.
      expect(mockApiKeyModel.deleteOne).toHaveBeenCalledWith({ _id: apiKeyId });
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should mint the key that lands exactly on the cap', async () => {
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey());
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(MAX_ACTIVE_KEYS_PER_USER);

      await expect(
        service.mint({ name: 'The last one', actorId, tenantId: 'tenant-a' }),
      ).resolves.toEqual(expect.objectContaining({ id: apiKeyId.toString() }));
      expect(mockApiKeyModel.deleteOne).not.toHaveBeenCalled();
    });

    /**
     * The whole of the fix: a count taken before the insert is a read another writer invalidates
     * before this one writes, so two concurrent mints both read nine and both insert. Counting
     * after the insert makes each writer's own row visible to its own check. Asserted as call
     * order rather than as an outcome, because the outcome of the racing pair is what this
     * ordering produces — no mocked model can interleave two calls to prove it directly.
     */
    it('should count the caller’s active keys only after writing its own row', async () => {
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey());
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(1);

      await service.mint({ name: 'CI integration', actorId, tenantId: 'tenant-a' });

      expect(mockApiKeyModel.create.mock.invocationCallOrder[0]).toBeLessThan(
        mockApiKeyModel.countDocuments.mock.invocationCallOrder[0],
      );
    });

    it('should scope the active key count by tenant, user, and non-revoked, unexpired status', async () => {
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(0);
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey());

      await service.mint({ name: 'CI integration', actorId, tenantId: 'tenant-a' });

      expect(mockApiKeyModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          userId,
          revokedAt: { $exists: false },
        }),
      );
    });

    it('should stamp the caller’s current session epoch onto the key', async () => {
      mockUserModel.findById.mockResolvedValueOnce(buildMockUser({ tokenVersion: 4 }));
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(0);
      mockApiKeyModel.create.mockResolvedValueOnce(buildMockApiKey({ tokenVersion: 4 }));

      await service.mint({ name: 'CI integration', actorId, tenantId: 'tenant-a' });

      expect(mockUserModel.findById).toHaveBeenCalledWith(actorId);
      expect(mockApiKeyModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ tokenVersion: 4 }),
      );
    });

    // Fails CLOSED: no row means no epoch to issue against, so no key is written at all.
    it('should refuse to mint when the caller’s user row is gone', async () => {
      mockUserModel.findById.mockResolvedValueOnce(null);

      await expect(
        service.mint({ name: 'CI integration', actorId, tenantId: 'tenant-a' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockApiKeyModel.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should list a user’s keys scoped by tenant and user, and record an audit event', async () => {
      mockApiKeyModel.find.mockResolvedValueOnce([buildMockApiKey()]);
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list(
        { skip: 0, limit: DEFAULT_PAGINATION_LIMIT },
        actorId,
        'tenant-a',
      );

      expect(mockApiKeyModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', userId },
        null,
        expect.objectContaining({
          sort: { createdAt: -1 },
          skip: 0,
          limit: DEFAULT_PAGINATION_LIMIT,
        }),
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

    it('should page results using the given skip and limit', async () => {
      mockApiKeyModel.find.mockResolvedValueOnce([buildMockApiKey()]);
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(5);

      const result = await service.list({ skip: 2, limit: 1 }, actorId, 'tenant-a');

      expect(mockApiKeyModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', userId },
        null,
        expect.objectContaining({ skip: 2, limit: 1 }),
      );
      expect(result.count).toBe(5);
    });

    it('should expose lastUsedAt on a listed key', async () => {
      const lastUsedAt = new Date('2026-08-01T00:00:00.000Z');
      mockApiKeyModel.find.mockResolvedValueOnce([buildMockApiKey({ lastUsedAt })]);
      mockApiKeyModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list(
        { skip: 0, limit: DEFAULT_PAGINATION_LIMIT },
        actorId,
        'tenant-a',
      );

      expect(result.docs[0].lastUsedAt).toBe(lastUsedAt);
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

  describe('rotate', () => {
    it('should throw ApiKeyNotFoundException for a malformed id', async () => {
      await expect(service.rotate('not-an-id', actorId, 'tenant-a')).rejects.toBeInstanceOf(
        ApiKeyNotFoundException,
      );
      expect(mockApiKeyModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw ApiKeyNotFoundException when no active key matches the user and tenant', async () => {
      mockApiKeyModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(service.rotate(apiKeyId.toString(), actorId, 'tenant-a')).rejects.toBeInstanceOf(
        ApiKeyNotFoundException,
      );
    });

    // Fails CLOSED: no row means no epoch to stamp the rotated token against, so nothing is written.
    it('should refuse to rotate when the caller’s user row is gone', async () => {
      mockUserModel.findById.mockResolvedValueOnce(null);

      await expect(service.rotate(apiKeyId.toString(), actorId, 'tenant-a')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockApiKeyModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should rotate the token, scoped to the owning user, tenant, and non-revoked status, and record an audit event', async () => {
      mockApiKeyModel.findOneAndUpdate.mockResolvedValueOnce(buildMockApiKey());

      const result = await service.rotate(apiKeyId.toString(), actorId, 'tenant-a');

      const [rotateFilter, rotateUpdate] = mockApiKeyModel.findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $set: { tokenHash: string; tokenPrefix: string; tokenVersion: number } },
      ];
      expect(rotateFilter).toEqual({
        _id: apiKeyId.toString(),
        userId,
        tenantId: 'tenant-a',
        revokedAt: { $exists: false },
      });
      expect(rotateUpdate.$set.tokenHash).toBe(hashOf(result.token));
      expect(rotateUpdate.$set.tokenPrefix.startsWith('eo_pat_')).toBe(true);
      expect(result.token.startsWith('eo_pat_')).toBe(true);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'api-keys.rotated',
        actorId,
        subject: { entityType: 'ApiKey', entityId: apiKeyId.toString() },
        tenantId: 'tenant-a',
      });
    });

    /**
     * The whole of the trap this guards: `ApiKey.tokenVersion` is `required` with no default, and
     * `verify` refuses any key whose stored epoch does not match the user's current one. Carrying
     * the existing row's `tokenVersion` forward — rather than reading the live `User` row — would
     * hand back a token that authenticates against a stale epoch and fails its very first use.
     */
    it('should stamp the caller’s current session epoch onto the rotated key, read fresh from the User row', async () => {
      mockUserModel.findById.mockResolvedValueOnce(buildMockUser({ tokenVersion: 4 }));
      mockApiKeyModel.findOneAndUpdate.mockResolvedValueOnce(buildMockApiKey({ tokenVersion: 4 }));

      await service.rotate(apiKeyId.toString(), actorId, 'tenant-a');

      expect(mockUserModel.findById).toHaveBeenCalledWith(actorId);
      const [, rotateUpdate] = mockApiKeyModel.findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $set: { tokenVersion: number } },
      ];
      expect(rotateUpdate.$set.tokenVersion).toBe(4);
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

    /**
     * The revocation lever `User.tokenVersion` is: raising it refuses every credential minted
     * before the raise, personal access tokens included. Without this the epoch would move only
     * the browser session and leave the MCP surface's only credential working.
     */
    it('should fail closed once the user’s session epoch has moved past the key’s', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(
        buildMockApiKey({ tokenHash: hashOf(token), tokenVersion: 0 }),
      );
      mockUserModel.findById.mockResolvedValueOnce(buildMockUser({ tokenVersion: 1 }));

      const result = await service.verify(token);

      expect(result).toBeNull();
    });

    // A key row predating the epoch field makes no claim about when it was issued, so it cannot be
    // shown to postdate a raise — refused rather than matched by a pair of absent values.
    it('should fail closed for a key row carrying no epoch at all', async () => {
      const token = buildPresentableToken();
      mockApiKeyModel.findOne.mockResolvedValueOnce(
        buildMockApiKey({ tokenHash: hashOf(token), tokenVersion: undefined }),
      );
      mockUserModel.findById.mockResolvedValueOnce(buildMockUser({ tokenVersion: undefined }));

      const result = await service.verify(token);

      expect(result).toBeNull();
    });
  });
});
