import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import {
  CanonicalEntity,
  HARVESTED_ALIAS_STATUSES,
  type HarvestedAliasStatus,
  MAX_HARVESTED_ALIASES_PER_ENTITY,
  normalizeEntityName,
} from '../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  CanonicalEntityNameConflictException,
  CanonicalEntityNotFoundException,
  HarvestedAliasAmbiguousException,
  HarvestedAliasNotFoundException,
  HarvestedAliasNotProposedException,
} from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import {
  CanonicalEntityService,
  MAX_HARVESTED_ENTRY_CHARACTERS,
} from '../../../../src/features/evidence/facts/canonical-entity.service';
import {
  harvestParentheticalAliases,
  type HarvestedAliasDefinition,
} from '../../../../src/features/evidence/facts/harvest-parenthetical-aliases';
import { DEFAULT_PAGINATION_LIMIT } from '../../../../src/shared/constants/pagination-defaults.constant';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('CanonicalEntityService', () => {
  const actorId = '65f1c2e4a1b2c3d4e5f6a7b9';
  let service: CanonicalEntityService;

  const mockCanonicalEntityModel = getMockModel();
  const mockExtractedFactModel = getMockModel();
  const mockLogger = getMockLogger();
  const mockAuditService = { record: jest.fn() };

  const buildMockCanonicalEntity = (overrides: Record<string, unknown> = {}) => ({
    canonicalName: 'Northgate Business Park',
    canonicalNameNormalized: 'northgate business park',
    aliases: ['Northgate Bus. Park'],
    aliasesNormalized: ['northgate bus. park'],
    harvestedAliases: [],
    tenantId: DEFAULT_TENANT_ID,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanonicalEntityService,
        { provide: getModelToken(CanonicalEntity.name), useValue: mockCanonicalEntityModel },
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
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

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith(
        { tenantId: 'other-tenant' },
        expect.anything(),
      );
    });

    /**
     * This runs once per question, over the tenant's whole registry, so whatever it loads is paid
     * for on every answer. `harvestedAliases` carries a verbatim span of a document per entry and
     * nothing here matches against it — the projection is what keeps a row's provenance off the
     * per-question path.
     */
    it('should project away the harvested-alias quotes the per-question read path never uses', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      await service.listCanonicalEntities(DEFAULT_TENANT_ID);

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID },
        { canonicalName: 1, canonicalNameNormalized: 1, aliasesNormalized: 1 },
      );
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
          harvestedAliases: [],
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
        harvestedAliases: [],
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

  describe('recordHarvestedAliases', () => {
    const versionId = new Types.ObjectId();
    const LOCATOR = { kind: 'pdf-page' as const, page: 4, extractorVersion: 'pdf-1' };

    const buildDefinition = (
      overrides: Partial<HarvestedAliasDefinition> = {},
    ): HarvestedAliasDefinition => ({
      subjectCandidates: [
        {
          name: 'at Northgate Business Park',
          quote: 'at Northgate Business Park (the "Property")',
        },
        { name: 'Northgate Business Park', quote: 'Northgate Business Park (the "Property")' },
        { name: 'Business Park', quote: 'Business Park (the "Property")' },
      ],
      aliases: ['Property', 'the Property'],
      locator: LOCATOR,
      ...overrides,
    });

    const buildHarvestRow = (overrides: Record<string, unknown> = {}) => ({
      ...buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } }),
      harvestedAliases: [] as Record<string, unknown>[],
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    it('should record nothing and query nothing when there are no definitions', async () => {
      await expect(
        service.recordHarvestedAliases([], DEFAULT_TENANT_ID, versionId, false),
      ).resolves.toBe(0);
      expect(mockCanonicalEntityModel.find).not.toHaveBeenCalled();
    });

    it('should look the antecedents up in one tenant-scoped query over both normalized forms', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      await service.recordHarvestedAliases(
        [
          buildDefinition(),
          buildDefinition({
            subjectCandidates: [
              {
                name: 'Northgate Business Park',
                quote: 'Northgate Business Park (the "Property")',
              },
            ],
          }),
        ],
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(mockCanonicalEntityModel.find).toHaveBeenCalledTimes(1);
      expect(mockCanonicalEntityModel.find).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        $or: [
          {
            canonicalNameNormalized: {
              $in: ['at northgate business park', 'northgate business park', 'business park'],
            },
          },
          {
            aliasesNormalized: {
              $in: ['at northgate business park', 'northgate business park', 'business park'],
            },
          },
        ],
      });
    });

    /**
     * The quote comes from the candidate that matched, not from the longest one offered. An
     * operator reading `at Northgate Business Park (…)` for an alias attributed to `Northgate
     * Business Park` is reading a citation whose leading text is not the antecedent the registry
     * used.
     */
    it('should cite the candidate the alias was attributed to, not the longest one offered', async () => {
      const row = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      await service.recordHarvestedAliases(
        [buildDefinition()],
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(row.harvestedAliases.map((entry) => entry.quote)).toEqual([
        'Northgate Business Park (the "Property")',
        'Northgate Business Park (the "Property")',
      ]);
    });

    it('should attach both alias forms to the row its antecedent names, with the quote and locator', async () => {
      const row = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      const recorded = await service.recordHarvestedAliases(
        [buildDefinition()],
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(recorded).toBe(2);
      expect(row.harvestedAliases).toEqual([
        {
          alias: 'Property',
          aliasNormalized: 'property',
          status: 'proposed',
          quote: 'Northgate Business Park (the "Property")',
          locator: LOCATOR,
          documentVersionId: versionId,
          // Recast rather than bare `expect.any(Date)` inside the object literal — its `any`-typed
          // return trips `no-unsafe-assignment` wherever it lands in one.
          harvestedAt: expect.any(Date) as Date,
        },
        expect.objectContaining({ alias: 'the Property', aliasNormalized: 'the property' }),
      ]);
      // `.save()` on the loaded document, not an `updateOne`/`$push`: only the document save path
      // runs the `pre('validate')` hook that derives `aliasesNormalized`.
      expect(row.save).toHaveBeenCalledTimes(1);
      expect(mockCanonicalEntityModel.updateOne).not.toHaveBeenCalled();
    });

    /** The flag decides the status and nothing else — same rows read, same entries written. */
    it.each([
      [false, 'proposed'],
      [true, 'applied'],
    ])('should record with autoApply %s as %s', async (autoApply, status) => {
      const row = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      await service.recordHarvestedAliases(
        [buildDefinition()],
        DEFAULT_TENANT_ID,
        versionId,
        autoApply,
      );

      expect(row.harvestedAliases.map((entry) => entry.status)).toEqual([status, status]);
    });

    it('should record nothing when no registered entity matches any antecedent candidate', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      await expect(
        service.recordHarvestedAliases([buildDefinition()], DEFAULT_TENANT_ID, versionId, true),
      ).resolves.toBe(0);
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("'Property'"));
    });

    it('should record nothing when an antecedent names two different registry rows', async () => {
      const first = buildHarvestRow();
      const second = buildHarvestRow({
        _id: { toString: () => 'entity-2' },
        canonicalName: 'Northgate Business Park (South)',
        canonicalNameNormalized: 'northgate business park (south)',
        aliasesNormalized: ['northgate business park'],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([first, second]);

      await expect(
        service.recordHarvestedAliases(
          [
            buildDefinition({
              subjectCandidates: [
                {
                  name: 'Northgate Business Park',
                  quote: 'Northgate Business Park (the "Property")',
                },
                { name: 'Business Park', quote: 'Business Park (the "Property")' },
              ],
            }),
          ],
          DEFAULT_TENANT_ID,
          versionId,
          true,
        ),
      ).resolves.toBe(0);
      expect(first.save).not.toHaveBeenCalled();
      expect(second.save).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('matches 2 distinct canonical entities'),
      );
    });

    it('should prefer the longest antecedent candidate that names a registered entity', async () => {
      const shortMatch = buildHarvestRow({
        _id: { toString: () => 'entity-2' },
        canonicalName: 'Business Park',
        canonicalNameNormalized: 'business park',
        aliasesNormalized: [],
      });
      const longMatch = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([shortMatch, longMatch]);

      await service.recordHarvestedAliases(
        [buildDefinition()],
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(longMatch.harvestedAliases).toHaveLength(2);
      expect(shortMatch.harvestedAliases).toEqual([]);
      expect(shortMatch.save).not.toHaveBeenCalled();
    });

    it('should match an antecedent against an operator-authored alias, not only the canonical name', async () => {
      const row = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      await service.recordHarvestedAliases(
        [
          buildDefinition({
            subjectCandidates: [
              { name: 'Northgate Bus. Park', quote: 'Northgate Bus. Park (the "Property")' },
            ],
          }),
        ],
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(row.harvestedAliases).toHaveLength(2);
    });

    it('should skip an alias that is already the row’s own canonical name', async () => {
      const row = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      await expect(
        service.recordHarvestedAliases(
          [buildDefinition({ aliases: ['Northgate  Business Park'] })],
          DEFAULT_TENANT_ID,
          versionId,
          false,
        ),
      ).resolves.toBe(0);
      expect(row.save).not.toHaveBeenCalled();
    });

    it('should skip an alias an operator already authored', async () => {
      const row = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      await expect(
        service.recordHarvestedAliases(
          [buildDefinition({ aliases: ['northgate bus. park'] })],
          DEFAULT_TENANT_ID,
          versionId,
          false,
        ),
      ).resolves.toBe(0);
      expect(row.save).not.toHaveBeenCalled();
    });

    /**
     * Swept over every status, not only `revoked`: an entry already on the row settles the
     * question whatever state it is in. Were `revoked` re-recordable, an operator's revocation
     * would last exactly until the next ingest of the document that defined the alias.
     */
    it.each(HARVESTED_ALIAS_STATUSES)(
      'should leave an alias already harvested as %s exactly as it stands',
      async (status) => {
        const existing = {
          alias: 'Property',
          aliasNormalized: 'property',
          status,
          quote: 'an earlier version said so',
          locator: LOCATOR,
          documentVersionId: new Types.ObjectId(),
          harvestedAt: new Date('2026-01-01T00:00:00.000Z'),
        };
        const row = buildHarvestRow({ harvestedAliases: [existing] });
        mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

        const recorded = await service.recordHarvestedAliases(
          [buildDefinition({ aliases: ['Property'] })],
          DEFAULT_TENANT_ID,
          versionId,
          true,
        );

        expect(recorded).toBe(0);
        expect(row.harvestedAliases).toEqual([existing]);
        expect(row.save).not.toHaveBeenCalled();
      },
    );

    it('should save a row once however many definitions land on it', async () => {
      const row = buildHarvestRow();
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      const recorded = await service.recordHarvestedAliases(
        [
          buildDefinition({ aliases: ['Property'] }),
          buildDefinition({
            aliases: ['Seller'],
            subjectCandidates: [
              { name: 'Northgate Business Park', quote: 'Northgate Business Park ("Seller")' },
            ],
          }),
        ],
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(recorded).toBe(2);
      expect(row.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('scanNearMatches', () => {
    const buildRow = (overrides: Record<string, unknown> = {}) => ({
      ...buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } }),
      harvestedAliases: [] as Record<string, unknown>[],
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    const buildFact = (overrides: Record<string, unknown> = {}) => ({
      factKey: { entity: 'Acme Tower, LLC', metric: 'noi', period: '2026' },
      rawText: 'Acme Tower, LLC reported NOI of $1.2M.',
      locator: { kind: 'pdf-page', page: 2, extractorVersion: 'pdf-1' },
      documentVersionId: new Types.ObjectId(),
      ...overrides,
    });

    it('should return 0 and query no facts when the tenant has no registered rows', async () => {
      mockCanonicalEntityModel.find.mockResolvedValueOnce([]);

      await expect(service.scanNearMatches(DEFAULT_TENANT_ID)).resolves.toBe(0);
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
    });

    it('should query only unresolved facts, sorted so the latest mention of a name wins', async () => {
      const row = buildRow({
        canonicalName: 'Acme Tower',
        canonicalNameNormalized: 'acme tower',
        aliases: [],
        aliasesNormalized: [],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      await service.scanNearMatches(DEFAULT_TENANT_ID);

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, entityMatched: false },
        { factKey: 1, rawText: 1, locator: 1, documentVersionId: 1 },
        { sort: { createdAt: -1 } },
      );
    });

    it('should propose an alias for an unresolved name differing from a registered row only by a corporate suffix', async () => {
      const row = buildRow({
        canonicalName: 'Acme Tower',
        canonicalNameNormalized: 'acme tower',
        aliases: [],
        aliasesNormalized: [],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);
      const fact = buildFact();
      mockExtractedFactModel.find.mockResolvedValueOnce([fact]);

      const recorded = await service.scanNearMatches(DEFAULT_TENANT_ID);

      expect(recorded).toBe(1);
      expect(row.harvestedAliases).toEqual([
        {
          alias: 'Acme Tower, LLC',
          aliasNormalized: 'acme tower, llc',
          status: 'proposed',
          quote: fact.rawText,
          locator: fact.locator,
          documentVersionId: fact.documentVersionId,
          harvestedAt: expect.any(Date) as Date,
        },
      ]);
      expect(row.save).toHaveBeenCalledTimes(1);
    });

    /** Two genuinely different entities, "Acme Tower" and "Acme Plaza", must never collapse to the
     *  same near-match key — the negative direction this queue exists to hold, checked at the
     *  service level rather than only against the normalizer it calls. */
    it('should not propose a match between two entities that merely share a word', async () => {
      const row = buildRow({
        canonicalName: 'Acme Tower',
        canonicalNameNormalized: 'acme tower',
        aliases: [],
        aliasesNormalized: [],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        buildFact({ factKey: { entity: 'Acme Plaza', metric: 'noi', period: '2026' } }),
      ]);

      await expect(service.scanNearMatches(DEFAULT_TENANT_ID)).resolves.toBe(0);
      expect(row.save).not.toHaveBeenCalled();
    });

    it('should skip a candidate whose exact normalized form already resolves against the registry', async () => {
      const row = buildRow({
        canonicalName: 'Acme Tower, LLC',
        canonicalNameNormalized: 'acme tower, llc',
        aliases: [],
        aliasesNormalized: [],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);
      mockExtractedFactModel.find.mockResolvedValueOnce([buildFact()]);

      await expect(service.scanNearMatches(DEFAULT_TENANT_ID)).resolves.toBe(0);
      expect(row.save).not.toHaveBeenCalled();
    });

    it('should record nothing when a candidate near-matches two distinct registered rows', async () => {
      const first = buildRow({
        _id: { toString: () => 'entity-1' },
        canonicalName: 'Acme Tower',
        canonicalNameNormalized: 'acme tower',
        aliases: [],
        aliasesNormalized: [],
      });
      const second = buildRow({
        _id: { toString: () => 'entity-2' },
        canonicalName: 'Acme Tower (Annex)',
        canonicalNameNormalized: 'acme tower (annex)',
        aliases: ['Acme Tower Inc'],
        aliasesNormalized: ['acme tower inc'],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([first, second]);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        buildFact({ factKey: { entity: 'Acme Tower LLC', metric: 'noi', period: '2026' } }),
      ]);

      const recorded = await service.scanNearMatches(DEFAULT_TENANT_ID);

      expect(recorded).toBe(0);
      expect(first.save).not.toHaveBeenCalled();
      expect(second.save).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('matches 2 distinct canonical entities'),
      );
    });

    it('should not re-propose a candidate already carried on the row as a decided harvested entry', async () => {
      const row = buildRow({
        canonicalName: 'Acme Tower',
        canonicalNameNormalized: 'acme tower',
        aliases: [],
        aliasesNormalized: [],
        harvestedAliases: [
          {
            alias: 'Acme Tower, LLC',
            aliasNormalized: 'acme tower, llc',
            status: 'revoked',
            quote: 'an earlier scan proposed this',
            locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-1' },
            documentVersionId: new Types.ObjectId(),
            harvestedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);
      mockExtractedFactModel.find.mockResolvedValueOnce([buildFact()]);

      await expect(service.scanNearMatches(DEFAULT_TENANT_ID)).resolves.toBe(0);
      expect(row.save).not.toHaveBeenCalled();
    });

    it('should keep only the latest fact per unresolved name when more than one mentions it', async () => {
      const row = buildRow({
        canonicalName: 'Acme Tower',
        canonicalNameNormalized: 'acme tower',
        aliases: [],
        aliasesNormalized: [],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);
      const latest = buildFact({ rawText: 'Latest mention of Acme Tower, LLC.' });
      const older = buildFact({ rawText: 'Older mention of Acme Tower, LLC.' });
      // The query itself sorts newest-first; the mock returns them in that order.
      mockExtractedFactModel.find.mockResolvedValueOnce([latest, older]);

      await service.scanNearMatches(DEFAULT_TENANT_ID);

      expect(row.harvestedAliases).toHaveLength(1);
      expect((row.harvestedAliases[0] as { quote: string }).quote).toBe(latest.rawText);
    });

    it('should skip a registered row and a candidate whose near-match key folds to nothing', async () => {
      const emptyKeyRow = buildRow({
        _id: { toString: () => 'entity-punct' },
        canonicalName: '-',
        canonicalNameNormalized: '-',
        aliases: [],
        aliasesNormalized: [],
      });
      const realRow = buildRow({
        canonicalName: 'Acme Tower',
        canonicalNameNormalized: 'acme tower',
        aliases: [],
        aliasesNormalized: [],
      });
      mockCanonicalEntityModel.find.mockResolvedValueOnce([emptyKeyRow, realRow]);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        buildFact({
          factKey: { entity: '...', metric: 'noi', period: '2026' },
          rawText: 'A stray punctuation-only entity name.',
        }),
        buildFact(),
      ]);

      const recorded = await service.scanNearMatches(DEFAULT_TENANT_ID);

      expect(recorded).toBe(1);
      expect(emptyKeyRow.save).not.toHaveBeenCalled();
      expect(realRow.harvestedAliases).toHaveLength(1);
    });
  });

  /**
   * The volume class, not the shape that reported it. Nothing upstream bounds a parsed element —
   * `TextParser` splits only on blank lines, `sanitizeEvidenceText` caps no length, and the upload
   * ceiling is 50 MB — so each case below is ordinary document text reaching the same array by a
   * different route: one enormous unbroken run, two spans the whitespace collapse hides, many
   * medium entries, many small entries spread over many rows, and one element stating a thousand
   * definitions. Every case asserts the same bound on what one row persists.
   */
  describe('the text one row persists, swept over the volume a document can carry', () => {
    const versionId = new Types.ObjectId();
    const LOCATOR: EvidenceLocator = { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-1' };

    const CANONICAL = 'Northgate Business Park';
    /** Four words at {@link MAX_HARVESTED_QUOTE_CHARACTERS}'s per-word ceiling — a registered name
     *  long enough that every citation cut at it is medium rather than short. */
    const LONG_NAME = ['Quarry', 'Ridgeline', 'Southbank', 'Tannery']
      .map((word) => word.padEnd(64, 'x'))
      .join(' ');

    const buildRow = (canonicalName: string) => ({
      _id: { toString: () => canonicalName },
      canonicalName,
      canonicalNameNormalized: normalizeEntityName(canonicalName),
      aliases: [] as string[],
      aliasesNormalized: [] as string[],
      harvestedAliases: [] as { alias: string; quote: string }[],
      save: jest.fn().mockResolvedValue(undefined),
    });

    const record = async (text: string, canonicalNames: readonly string[]) => {
      const rows = canonicalNames.map(buildRow);
      mockCanonicalEntityModel.find.mockResolvedValueOnce(rows);

      await service.recordHarvestedAliases(
        harvestParentheticalAliases([{ text, locator: LOCATOR, headingPath: [] }]),
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      return rows;
    };

    const sentences = (count: number, build: (index: number) => string): string =>
      Array.from({ length: count }, (_, index) => `${build(index)}.`).join(' ');

    const VOLUME_CASES = [
      {
        name: 'one enormous unbroken run before the antecedent',
        canonicalNames: [CANONICAL],
        text: () => `${'A'.repeat(500_000)} ${CANONICAL} (the "Property")`,
      },
      {
        name: 'an enormous whitespace run between the antecedent and the parenthesis',
        canonicalNames: [CANONICAL],
        text: () => `${CANONICAL}${' '.repeat(500_000)}(the "Property")`,
      },
      {
        name: 'an enormous whitespace run inside the defined term',
        canonicalNames: [CANONICAL],
        text: () => `${CANONICAL} (the "Long${' '.repeat(500_000)}Lease")`,
      },
      {
        name: 'four hundred medium definitions naming one row',
        canonicalNames: [LONG_NAME],
        text: () => sentences(400, (index) => `${LONG_NAME} (the "Term${index}")`),
      },
      {
        name: 'six hundred small definitions spread over twenty rows',
        canonicalNames: Array.from({ length: 20 }, (_, row) => `Entity ${row} Holdings`),
        text: () =>
          Array.from({ length: 20 }, (_, row) =>
            sentences(30, (index) => `Entity ${row} Holdings (the "Term${row}x${index}")`),
          ).join(' '),
      },
      {
        name: 'one element stating a thousand definitions',
        canonicalNames: [CANONICAL],
        text: () => sentences(1000, (index) => `${CANONICAL} (the "Term${index}")`),
      },
    ] as const;

    for (const volumeCase of VOLUME_CASES) {
      it(`bounds every row's harvested text — ${volumeCase.name}`, async () => {
        const rows = await record(volumeCase.text(), volumeCase.canonicalNames);

        for (const row of rows) {
          expect(row.harvestedAliases.length).toBeLessThanOrEqual(MAX_HARVESTED_ALIASES_PER_ENTITY);

          for (const entry of row.harvestedAliases) {
            expect(entry.quote.length + entry.alias.length).toBeLessThanOrEqual(
              MAX_HARVESTED_ENTRY_CHARACTERS,
            );
          }

          const persisted = row.harvestedAliases.reduce(
            (total, entry) => total + entry.quote.length + entry.alias.length,
            0,
          );
          expect(persisted).toBeLessThanOrEqual(
            MAX_HARVESTED_ALIASES_PER_ENTITY * MAX_HARVESTED_ENTRY_CHARACTERS,
          );
        }
      });
    }

    /** The bound costs the definition its over-long citations, never the alias a shorter candidate
     *  still attributes: the enormous run reaches back past `Northgate Business Park`, which is
     *  where the registry matches. */
    it('still records an alias whose matching antecedent sits inside the bound', async () => {
      const [row] = await record(`${'A'.repeat(500_000)} ${CANONICAL} (the "Property")`, [
        CANONICAL,
      ]);

      expect(row.harvestedAliases.map((entry) => entry.quote)).toEqual([
        `${CANONICAL} (the "Property")`,
        `${CANONICAL} (the "Property")`,
      ]);
    });

    /** No candidate survives when the span itself is the volume, so the definition is refused
     *  whole rather than cited by a clipped quote. */
    it.each([
      ['a whitespace run before the parenthesis', `${CANONICAL}${' '.repeat(500_000)}(the "P")`],
      ['a whitespace run inside the term', `${CANONICAL} (the "Long${' '.repeat(500_000)}Lease")`],
    ])('records nothing when %s puts every candidate over the bound', async (_name, text) => {
      const [row] = await record(text, [CANONICAL]);

      expect(row.harvestedAliases).toEqual([]);
      expect(row.save).not.toHaveBeenCalled();
    });

    /** The bounds are invisible to the definitions they exist for — including the line-wrapped
     *  shape a PDF text layer routinely emits. */
    it.each([
      ['unwrapped', `The asset is ${CANONICAL} (the "Property").`],
      ['wrapped and indented', `The asset is ${CANONICAL} (the\n   "Property").`],
    ])('leaves a legitimate %s definition untouched', async (_name, text) => {
      const [row] = await record(text, [CANONICAL]);

      expect(row.harvestedAliases.map((entry) => entry.alias)).toEqual([
        'Property',
        'the Property',
      ]);
      for (const entry of row.harvestedAliases) {
        expect(text).toContain(entry.quote);
        expect(entry.quote.startsWith(CANONICAL)).toBe(true);
      }
    });

    /** The per-entry gate answers to what it is handed, not to what the harvester promises — it is
     *  the last thing standing between a producer and a row that grows past the BSON ceiling. */
    it('refuses an entry a caller hands it over the budget, whatever the harvester would have cut', async () => {
      const row = buildRow(CANONICAL);
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      const recorded = await service.recordHarvestedAliases(
        [
          {
            subjectCandidates: [
              { name: CANONICAL, quote: 'B'.repeat(MAX_HARVESTED_ENTRY_CHARACTERS + 1) },
            ],
            aliases: ['Property'],
            locator: LOCATOR,
          },
        ],
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(recorded).toBe(0);
      expect(row.harvestedAliases).toEqual([]);
      expect(row.save).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `over the ${MAX_HARVESTED_ENTRY_CHARACTERS}-character entry budget`,
        ),
      );
    });

    it('refuses a further entry once a row already holds the cap', async () => {
      const row = buildRow(CANONICAL);
      row.harvestedAliases = Array.from(
        { length: MAX_HARVESTED_ALIASES_PER_ENTITY },
        (_, index) => ({
          alias: `Existing${index}`,
          aliasNormalized: `existing${index}`,
          quote: `${CANONICAL} (the "Existing${index}")`,
        }),
      );
      mockCanonicalEntityModel.find.mockResolvedValueOnce([row]);

      const recorded = await service.recordHarvestedAliases(
        harvestParentheticalAliases([
          { text: `${CANONICAL} (the "Property").`, locator: LOCATOR, headingPath: [] },
        ]),
        DEFAULT_TENANT_ID,
        versionId,
        false,
      );

      expect(recorded).toBe(0);
      expect(row.harvestedAliases).toHaveLength(MAX_HARVESTED_ALIASES_PER_ENTITY);
      expect(row.save).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `already holds ${MAX_HARVESTED_ALIASES_PER_ENTITY} harvested aliases`,
        ),
      );
    });
  });

  describe('revokeHarvestedAlias', () => {
    const LOCATOR = { kind: 'pdf-page' as const, page: 4, extractorVersion: 'pdf-1' };

    const buildRevokableRow = (status: HarvestedAliasStatus = 'applied') => ({
      ...buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } }),
      harvestedAliases: [
        {
          alias: 'Property',
          aliasNormalized: 'property',
          status,
          quote: 'Northgate Business Park (the "Property")',
          locator: LOCATOR,
          documentVersionId: { toString: () => 'version-1' },
          harvestedAt: new Date('2026-07-02T00:00:00.000Z'),
        },
      ],
      save: jest.fn().mockResolvedValue(undefined),
    });

    it('should throw CanonicalEntityNotFoundException for a malformed id, without querying the model', async () => {
      await expect(
        service.revokeHarvestedAlias('not-an-object-id', DEFAULT_TENANT_ID, 'Property', actorId),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
      expect(mockCanonicalEntityModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw CanonicalEntityNotFoundException when no row matches the id and tenant', async () => {
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.revokeHarvestedAlias(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          'Property',
          actorId,
        ),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
      expect(mockCanonicalEntityModel.findOne).toHaveBeenCalledWith({
        _id: '65f1c2e4a1b2c3d4e5f6a7b8',
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    it('should throw HarvestedAliasNotFoundException when the row carries no such harvested alias', async () => {
      const row = buildRevokableRow();
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

      await expect(
        service.revokeHarvestedAlias(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          'Seller',
          actorId,
        ),
      ).rejects.toBeInstanceOf(HarvestedAliasNotFoundException);
      expect(row.save).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should mark the alias revoked, save through the document path, and record an audit event', async () => {
      const row = buildRevokableRow();
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

      const result = await service.revokeHarvestedAlias(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        'Property',
        actorId,
      );

      expect(row.harvestedAliases[0].status).toBe('revoked');
      expect(row.save).toHaveBeenCalledTimes(1);
      expect(mockCanonicalEntityModel.updateOne).not.toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'canonical-entities.harvested-alias-revoked',
        actorId,
        subject: { entityType: 'CanonicalEntity', entityId: '65f1c2e4a1b2c3d4e5f6a7b8' },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result.harvestedAliases).toEqual([
        {
          alias: 'Property',
          status: 'revoked',
          quote: 'Northgate Business Park (the "Property")',
          locator: LOCATOR,
          documentVersionId: 'version-1',
          harvestedAt: new Date('2026-07-02T00:00:00.000Z'),
        },
      ]);
    });

    it('should identify the alias by the same normalized form resolution matches on', async () => {
      const row = buildRevokableRow();
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

      await service.revokeHarvestedAlias(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        '  PROPERTY  ',
        actorId,
      );

      expect(row.harvestedAliases[0].status).toBe('revoked');
    });

    /**
     * The entry cap lives in `recordHarvestedAliases`, not in a schema validator, so that a row
     * holding more entries than the cap still saves. A validator would refuse this save and leave
     * an operator unable to retire any of the entries the cap exists to stop accumulating.
     */
    it('should still revoke on a row already holding more entries than the cap', async () => {
      const row = buildRevokableRow();
      row.harvestedAliases = [
        ...row.harvestedAliases,
        ...Array.from(
          { length: MAX_HARVESTED_ALIASES_PER_ENTITY },
          (_, index): (typeof row.harvestedAliases)[number] => ({
            alias: `Existing${index}`,
            aliasNormalized: `existing${index}`,
            status: 'applied',
            quote: `Northgate Business Park (the "Existing${index}")`,
            locator: LOCATOR,
            documentVersionId: { toString: () => 'version-1' },
            harvestedAt: new Date('2026-07-02T00:00:00.000Z'),
          }),
        ),
      ];
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

      await service.revokeHarvestedAlias(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        'Property',
        actorId,
      );

      expect(row.harvestedAliases).toHaveLength(MAX_HARVESTED_ALIASES_PER_ENTITY + 1);
      expect(row.harvestedAliases[0].status).toBe('revoked');
      expect(row.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('applyHarvestedAlias', () => {
    const LOCATOR = { kind: 'pdf-page' as const, page: 2, extractorVersion: 'pdf-1' };

    const buildApplicableRow = (status: HarvestedAliasStatus = 'proposed') => ({
      ...buildMockCanonicalEntity({ _id: { toString: () => 'entity-1' } }),
      harvestedAliases: [
        {
          alias: 'Acme Tower, LLC',
          aliasNormalized: 'acme tower, llc',
          status,
          quote: 'Acme Tower, LLC reported NOI of $1.2M.',
          locator: LOCATOR,
          documentVersionId: { toString: () => 'version-1' },
          harvestedAt: new Date('2026-07-02T00:00:00.000Z'),
        },
      ],
      save: jest.fn().mockResolvedValue(undefined),
    });

    it('should throw CanonicalEntityNotFoundException for a malformed id, without querying the model', async () => {
      await expect(
        service.applyHarvestedAlias(
          'not-an-object-id',
          DEFAULT_TENANT_ID,
          'Acme Tower, LLC',
          actorId,
        ),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
      expect(mockCanonicalEntityModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw CanonicalEntityNotFoundException when no row matches the id and tenant', async () => {
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.applyHarvestedAlias(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          'Acme Tower, LLC',
          actorId,
        ),
      ).rejects.toBeInstanceOf(CanonicalEntityNotFoundException);
    });

    it('should throw HarvestedAliasNotFoundException when the row carries no such harvested alias', async () => {
      const row = buildApplicableRow();
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

      await expect(
        service.applyHarvestedAlias(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          'Unknown',
          actorId,
        ),
      ).rejects.toBeInstanceOf(HarvestedAliasNotFoundException);
      expect(row.save).not.toHaveBeenCalled();
    });

    /** `revoked` is documented terminal, and `applied` has nothing left to do — both must refuse
     *  rather than silently un-terminate a rejection or re-audit a standing state. */
    it.each(['applied', 'revoked'] as const)(
      'should throw HarvestedAliasNotProposedException rather than move an already-%s entry',
      async (status) => {
        const row = buildApplicableRow(status);
        mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

        await expect(
          service.applyHarvestedAlias(
            '65f1c2e4a1b2c3d4e5f6a7b8',
            DEFAULT_TENANT_ID,
            'Acme Tower, LLC',
            actorId,
          ),
        ).rejects.toBeInstanceOf(HarvestedAliasNotProposedException);
        expect(row.save).not.toHaveBeenCalled();
        expect(mockAuditService.record).not.toHaveBeenCalled();
      },
    );

    /**
     * The registry can grow between a proposal being raised and an operator confirming it — a
     * second row may since have been registered under, or authored an alias of, the very name this
     * proposal names. Applying anyway would land an alias `resolve`'s own ambiguity branch
     * immediately refuses to serve, so this must fail CLOSED instead of silently doing nothing
     * useful.
     */
    it('should throw HarvestedAliasAmbiguousException when the alias now also names a different row', async () => {
      const entityId = { toString: () => 'entity-1' };
      const row = { ...buildApplicableRow('proposed'), _id: entityId };
      const conflictingRow = { _id: { toString: () => 'entity-2' } };
      mockCanonicalEntityModel.findOne
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce(conflictingRow);

      await expect(
        service.applyHarvestedAlias(
          '65f1c2e4a1b2c3d4e5f6a7b8',
          DEFAULT_TENANT_ID,
          'Acme Tower, LLC',
          actorId,
        ),
      ).rejects.toBeInstanceOf(HarvestedAliasAmbiguousException);
      expect(mockCanonicalEntityModel.findOne).toHaveBeenNthCalledWith(2, {
        tenantId: DEFAULT_TENANT_ID,
        _id: { $ne: entityId },
        $or: [
          { canonicalNameNormalized: 'acme tower, llc' },
          { aliasesNormalized: 'acme tower, llc' },
        ],
      });
      expect(row.save).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should apply a proposed alias, save through the document path, and record an audit event', async () => {
      const row = buildApplicableRow('proposed');
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

      const result = await service.applyHarvestedAlias(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        'Acme Tower, LLC',
        actorId,
      );

      expect(row.harvestedAliases[0].status).toBe('applied');
      expect(row.save).toHaveBeenCalledTimes(1);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'canonical-entities.harvested-alias-applied',
        actorId,
        subject: { entityType: 'CanonicalEntity', entityId: '65f1c2e4a1b2c3d4e5f6a7b8' },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result.harvestedAliases[0].status).toBe('applied');
    });

    it('should identify the alias by the same normalized form resolution matches on', async () => {
      const row = buildApplicableRow('proposed');
      mockCanonicalEntityModel.findOne.mockResolvedValueOnce(row);

      await service.applyHarvestedAlias(
        '65f1c2e4a1b2c3d4e5f6a7b8',
        DEFAULT_TENANT_ID,
        '  acme tower, LLC  ',
        actorId,
      );

      expect(row.harvestedAliases[0].status).toBe('applied');
    });
  });
});
