import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { CanonicalEntity } from '../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import { CanonicalEntityService } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('CanonicalEntityService', () => {
  let service: CanonicalEntityService;

  const mockCanonicalEntityModel = getMockModel();
  const mockLogger = getMockLogger();

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
});
