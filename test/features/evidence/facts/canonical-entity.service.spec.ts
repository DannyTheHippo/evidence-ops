import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { CanonicalEntity } from '../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import {
  CanonicalEntityNameConflictException,
  CanonicalEntityNotFoundException,
} from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { CanonicalEntityService } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { DEFAULT_PAGINATION_LIMIT } from '../../../../src/shared/constants/pagination-defaults.constant';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('CanonicalEntityService', () => {
  const actorId = '65f1c2e4a1b2c3d4e5f6a7b9';
  let service: CanonicalEntityService;

  const mockCanonicalEntityModel = getMockModel();
  const mockLogger = getMockLogger();
  const mockAuditService = { record: jest.fn() };

  const buildMockCanonicalEntity = (overrides: Record<string, unknown> = {}) => ({
    canonicalName: 'Northgate Business Park',
    canonicalNameNormalized: 'northgate business park',
    aliases: ['Northgate Bus. Park'],
    aliasesNormalized: ['northgate bus. park'],
    tenantId: DEFAULT_TENANT_ID,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanonicalEntityService,
        { provide: getModelToken(CanonicalEntity.name), useValue: mockCanonicalEntityModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<CanonicalEntityService>(CanonicalEntityService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('resolve', () => {
    it('should return the canonical name and matched: true on an exact canonical-name match', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([buildMockCanonicalEntity()]);

      const result = await service.resolve('  Northgate   Business Park ', DEFAULT_TENANT_ID);

      expect(result).toEqual({ name: 'Northgate Business Park', matched: true });
      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        $or: [
          { canonicalNameNormalized: 'northgate business park' },
          { aliasesNormalized: 'northgate business park' },
        ],
      });
    });

    it('should return the canonical name and matched: true on an alias match', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([buildMockCanonicalEntity()]);

      const result = await service.resolve('Northgate Bus. Park', DEFAULT_TENANT_ID);

      expect(result).toEqual({ name: 'Northgate Business Park', matched: true });
      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        $or: [
          { canonicalNameNormalized: 'northgate bus. park' },
          { aliasesNormalized: 'northgate bus. park' },
        ],
      });
    });

    it('should return the input unchanged with matched: false when nothing registers it', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      const result = await service.resolve('Unlisted Property LLC', DEFAULT_TENANT_ID);

      expect(result).toEqual({ name: 'Unlisted Property LLC', matched: false });
    });

    it('should scope the lookup to the given tenant', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      await service.resolve('Northgate Business Park', 'other-tenant');

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'other-tenant' }),
      );
    });

    it('should return the input unchanged with matched: false when the alias matches two distinct canonical names', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([
        buildMockCanonicalEntity({
          canonicalName: 'Northgate Business Park',
          canonicalNameNormalized: 'northgate business park',
          aliases: ['Northgate'],
          aliasesNormalized: ['northgate'],
        }),
        buildMockCanonicalEntity({
          canonicalName: 'Northgate Logistics',
          canonicalNameNormalized: 'northgate logistics',
          aliases: ['Northgate'],
          aliasesNormalized: ['northgate'],
        }),
      ]);

      const result = await service.resolve('Northgate', DEFAULT_TENANT_ID);

      expect(result).toEqual({ name: 'Northgate', matched: false });
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('resolveMany', () => {
    it('should return an empty array without querying the model when rawNames is empty', async () => {
      const result = await service.resolveMany([], DEFAULT_TENANT_ID);

      expect(result).toEqual([]);
      expect(mockCanonicalEntityModel.find).not.toHaveBeenCalled();
    });

    it('should resolve a batch in one query, mixing canonical-name, alias, and unmatched names', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([buildMockCanonicalEntity()]);

      const result = await service.resolveMany(
        ['Northgate Business Park', 'Northgate Bus. Park', 'Unlisted Property LLC'],
        DEFAULT_TENANT_ID,
      );

      expect(result).toEqual([
        { name: 'Northgate Business Park', matched: true },
        { name: 'Northgate Business Park', matched: true },
        { name: 'Unlisted Property LLC', matched: false },
      ]);
      // One query for the whole batch, not one per name — the entire point of batching.
      expect(mockCanonicalEntityModel.find).toHaveBeenCalledTimes(1);
      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        $or: [
          {
            canonicalNameNormalized: {
              $in: ['northgate business park', 'northgate bus. park', 'unlisted property llc'],
            },
          },
          {
            aliasesNormalized: {
              $in: ['northgate business park', 'northgate bus. park', 'unlisted property llc'],
            },
          },
        ],
      });
    });

    it('should query only the unique normalized names when rawNames repeats one', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([buildMockCanonicalEntity()]);

      const result = await service.resolveMany(
        ['Northgate Business Park', '  Northgate   Business Park '],
        DEFAULT_TENANT_ID,
      );

      expect(result).toEqual([
        { name: 'Northgate Business Park', matched: true },
        { name: 'Northgate Business Park', matched: true },
      ]);
      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        $or: [
          { canonicalNameNormalized: { $in: ['northgate business park'] } },
          { aliasesNormalized: { $in: ['northgate business park'] } },
        ],
      });
    });

    it('should scope the batched lookup to the given tenant', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      await service.resolveMany(['Unlisted Property LLC'], 'other-tenant');

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'other-tenant' }),
      );
    });

    it('should return matched: false for a name whose alias matches two distinct canonical names, without disturbing other names in the batch', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([
        buildMockCanonicalEntity({
          canonicalName: 'Northgate Business Park',
          canonicalNameNormalized: 'northgate business park',
          aliases: ['Northgate'],
          aliasesNormalized: ['northgate'],
        }),
        buildMockCanonicalEntity({
          canonicalName: 'Northgate Logistics',
          canonicalNameNormalized: 'northgate logistics',
          aliases: ['Northgate'],
          aliasesNormalized: ['northgate'],
        }),
      ]);

      const result = await service.resolveMany(
        ['Northgate', 'Northgate Business Park'],
        DEFAULT_TENANT_ID,
      );

      expect(result).toEqual([
        { name: 'Northgate', matched: false },
        { name: 'Northgate Business Park', matched: true },
      ]);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('listCanonicalEntities', () => {
    it('should project every registered entity to its canonical name and both normalized forms', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([
        buildMockCanonicalEntity(),
        buildMockCanonicalEntity({
          canonicalName: 'Sablewood Retail Court',
          canonicalNameNormalized: 'sablewood retail court',
          aliases: [],
          aliasesNormalized: [],
        }),
      ]);

      const result = await service.listCanonicalEntities(DEFAULT_TENANT_ID);

      expect(result).toEqual([
        {
          canonicalName: 'Northgate Business Park',
          canonicalNameNormalized: 'northgate business park',
          aliasesNormalized: ['northgate bus. park'],
        },
        {
          canonicalName: 'Sablewood Retail Court',
          canonicalNameNormalized: 'sablewood retail court',
          aliasesNormalized: [],
        },
      ]);
    });

    it('should scope the listing to the given tenant', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      await service.listCanonicalEntities('other-tenant');

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith({ tenantId: 'other-tenant' });
    });

    it('should return an empty array when the tenant has no registered entities', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      const result = await service.listCanonicalEntities(DEFAULT_TENANT_ID);

      expect(result).toEqual([]);
    });
  });

  describe('listForTenant', () => {
    it('should return the tenant-authored rows paginated as { docs, count }, mapped to plain results', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([
        buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } }),
      ]);
      mockCanonicalEntityModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.listForTenant(DEFAULT_TENANT_ID, {
        skip: 0,
        limit: DEFAULT_PAGINATION_LIMIT,
      });

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID },
        null,
        expect.objectContaining({
          sort: { createdAt: -1 },
          skip: 0,
          limit: DEFAULT_PAGINATION_LIMIT,
        }),
      );
      expect(result.count).toBe(1);
      expect(result.docs).toEqual([
        {
          id: 'entity-1',
          canonicalName: 'Northgate Business Park',
          aliases: ['Northgate Bus. Park'],
          createdAt: undefined,
        },
      ]);
    });

    it('should page results using the given skip and limit', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);
      mockCanonicalEntityModel.countDocuments.mockResolvedValueOnce(5);

      const result = await service.listForTenant(DEFAULT_TENANT_ID, { skip: 2, limit: 1 });

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID },
        null,
        expect.objectContaining({ skip: 2, limit: 1 }),
      );
      expect(result.count).toBe(5);
    });
  });

  describe('create', () => {
    it('should create a row scoped to the tenant and default aliases to an empty array', async () => {
      const created = buildMockCanonicalEntity({
        _id: { toString: () => 'entity-1' },
        aliases: [],
      });
      mockCanonicalEntityModel.create.mockResolvedValueOnce(created);

      const result = await service.create(
        DEFAULT_TENANT_ID,
        { canonicalName: 'Northgate Business Park' },
        actorId,
      );

      expect(mockCanonicalEntityModel.create).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        canonicalName: 'Northgate Business Park',
        aliases: [],
      });
      expect(result).toEqual({
        id: 'entity-1',
        canonicalName: 'Northgate Business Park',
        aliases: [],
        createdAt: undefined,
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'canonical-entities.created',
        actorId,
        subject: { entityType: 'CanonicalEntity', entityId: 'entity-1' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    it('should pass aliases through when given', async () => {
      const created = buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } });
      mockCanonicalEntityModel.create.mockResolvedValueOnce(created);

      await service.create(
        DEFAULT_TENANT_ID,
        { canonicalName: 'Northgate Business Park', aliases: ['Northgate Bus. Park'] },
        actorId,
      );

      expect(mockCanonicalEntityModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ aliases: ['Northgate Bus. Park'] }),
      );
    });

    it('should map a duplicate-name E11000 error to CanonicalEntityNameConflictException', async () => {
      mockCanonicalEntityModel.create.mockRejectedValueOnce({ code: 11000 });

      await expect(
        service.create(DEFAULT_TENANT_ID, { canonicalName: 'Northgate Business Park' }, actorId),
      ).rejects.toBeInstanceOf(CanonicalEntityNameConflictException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should rethrow a non-duplicate-key error unchanged', async () => {
      const error = new Error('connection reset');
      mockCanonicalEntityModel.create.mockRejectedValueOnce(error);

      await expect(
        service.create(DEFAULT_TENANT_ID, { canonicalName: 'Northgate Business Park' }, actorId),
      ).rejects.toBe(error);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const buildSavableEntity = (overrides: Record<string, unknown> = {}) => ({
      ...buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } }),
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    it('should throw CanonicalEntityNotFoundException for a malformed id, without querying the model', async () => {
      await expect(
        service.update(
          'not-an-object-id',
          DEFAULT_TENANT_ID,
          { canonicalName: 'New Name' },
          actorId,
        ),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
      expect(mockCanonicalEntityModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw CanonicalEntityNotFoundException when no row matches the id and tenant', async () => {
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.update(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          { canonicalName: 'New Name' },
          actorId,
        ),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
    });

    it("should load the row with findOne and mutate then save it, so the schema’s pre('validate') normalization hook fires", async () => {
      const entity = buildSavableEntity();
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(entity);

      const result = await service.update(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        { canonicalName: 'Northgate Renamed', aliases: ['Northgate Renamed Alias'] },
        actorId,
      );

      expect(mockCanonicalEntityModel.findOne).toHaveBeenCalledWith({
        _id: '65f1c2e4a1b2c3d4e5f6a7b8',
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(entity.canonicalName).toBe('Northgate Renamed');
      expect(entity.aliases).toEqual(['Northgate Renamed Alias']);
      expect(entity.save).toHaveBeenCalled();
      expect(result.canonicalName).toBe('Northgate Renamed');
      expect(result.aliases).toEqual(['Northgate Renamed Alias']);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'canonical-entities.updated',
        actorId,
        subject: { entityType: 'CanonicalEntity', entityId: '65f1c2e4a1b2c3d4e5f6a7b8' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    it('should leave aliases untouched when omitted from updates', async () => {
      const entity = buildSavableEntity();
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(entity);

      await service.update(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        { canonicalName: 'Northgate Renamed' },
        actorId,
      );

      expect(entity.canonicalName).toBe('Northgate Renamed');
      expect(entity.aliases).toEqual(['Northgate Bus. Park']);
    });

    it('should leave canonicalName untouched when omitted from updates', async () => {
      const entity = buildSavableEntity();
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(entity);

      await service.update(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        { aliases: ['New Alias'] },
        actorId,
      );

      expect(entity.canonicalName).toBe('Northgate Business Park');
      expect(entity.aliases).toEqual(['New Alias']);
    });

    it('should map a duplicate-name E11000 error on save to CanonicalEntityNameConflictException', async () => {
      const entity = buildSavableEntity({ save: jest.fn().mockRejectedValueOnce({ code: 11000 }) });
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(entity);

      await expect(
        service.update(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          { canonicalName: 'Sablewood Retail Court' },
          actorId,
        ),
      ).rejects.toBeInstanceOf(CanonicalEntityNameConflictException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should rethrow a non-duplicate-key save error unchanged', async () => {
      const error = new Error('connection reset');
      const entity = buildSavableEntity({ save: jest.fn().mockRejectedValueOnce(error) });
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(entity);

      await expect(
        service.update(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          { canonicalName: 'New Name' },
          actorId,
        ),
      ).rejects.toBe(error);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should throw CanonicalEntityNotFoundException for a malformed id, without querying the model', async () => {
      await expect(
        service.remove('not-an-object-id', DEFAULT_TENANT_ID, actorId),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
      expect(mockCanonicalEntityModel.findOneAndDelete).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should throw CanonicalEntityNotFoundException when no row matches the id and tenant', async () => {
      mockCanonicalEntityModel.findOneAndDelete.mockResolvedValueOnce(null);

      await expect(
        service.remove('65f1c2e4a1b2c3d4e5f6a7b8', DEFAULT_TENANT_ID, actorId),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should delete the row scoped to the tenant and record an audit event naming it', async () => {
      mockCanonicalEntityModel.findOneAndDelete.mockResolvedValueOnce(
        buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } }),
      );

      await service.remove('65f1c2e4a1b2c3d4e5f6a7b8', DEFAULT_TENANT_ID, actorId);

      expect(mockCanonicalEntityModel.findOneAndDelete).toHaveBeenCalledWith({
        _id: '65f1c2e4a1b2c3d4e5f6a7b8',
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'canonical-entities.removed',
        actorId,
        subject: { entityType: 'CanonicalEntity', entityId: '65f1c2e4a1b2c3d4e5f6a7b8' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });
  });
});
