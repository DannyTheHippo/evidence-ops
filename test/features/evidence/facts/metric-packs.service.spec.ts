import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import {
  CRE_PACK_ID,
  MetricPack,
  type MetricDefinition,
} from '../../../../src/database/schemas/evidence/metric-pack/metric-pack.schema';
import {
  MetricPackFrozenArithmeticException,
  MetricPackMetricRemovalException,
  MetricPackNotDraftException,
  MetricPackNotFoundException,
  MetricPackNotPublishedException,
  MetricPackVersionConflictException,
} from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { MetricPacksService } from '../../../../src/features/evidence/facts/metric-packs.service';
import { CRE_PACK_V1 } from '../../../../src/features/evidence/facts/packs/cre.pack';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('MetricPacksService', () => {
  const EPOCH = new Date('2026-01-01T00:00:00.000Z');
  const actorId = '65f1c2e4a1b2c3d4e5f6a7b9';
  let service: MetricPacksService;

  const mockMetricPackModel = getMockModel();
  const mockLogger = getMockLogger();
  const mockAuditService = { record: jest.fn() };

  const capRate: MetricDefinition = {
    id: 'cap_rate',
    label: 'Cap Rate',
    aliases: ['Cap Rate'],
    valueType: 'percentage',
    canonicalUnit: 'ratio',
    units: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
    toleranceKind: 'absolute',
    tolerance: 0.0025,
  };
  const salePrice: MetricDefinition = {
    id: 'sale_price',
    label: 'Sale Price',
    aliases: ['Sale Price'],
    valueType: 'currency',
    canonicalUnit: 'usd',
    units: [
      { id: 'usd', toCanonicalFactor: 1 },
      { id: 'usd_thousands', toCanonicalFactor: 1_000 },
    ],
    toleranceKind: 'relative',
    tolerance: 0.01,
  };
  const parentMetrics: MetricDefinition[] = [capRate, salePrice];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricPacksService,
        { provide: getModelToken(MetricPack.name), useValue: mockMetricPackModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<MetricPacksService>(MetricPacksService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('resolveActive', () => {
    it('should scope the lookup to the given tenant and active status', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);

      await service.resolveActive(DEFAULT_TENANT_ID);

      expect(mockMetricPackModel.findOne).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        status: 'active',
      });
    });

    it('should resolve to the code default CRE_PACK_V1 when the tenant has no active pack', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);

      const pack = await service.resolveActive(DEFAULT_TENANT_ID);

      expect(pack).toBe(CRE_PACK_V1);
    });

    it("should resolve the eval harness's tenant to ('cre', 1), pinning the model-cache replay corpus", async () => {
      // Duplicated from `eval/run.ts`'s own (unexported) `EVAL_TENANT_ID` constant, not imported —
      // same `src`/`eval` boundary convention that file's own header comment establishes. No
      // `MetricPack` row is seeded for this tenant, so a future edit to `CRE_PACK_V1`'s `packId` or
      // `version` — or a migration that seeds an active pack for this tenant — would change what
      // `eval/cache/model/`'s committed fixtures were recorded against, and this test is what
      // catches that before the eval's `ModelReplayCacheMissError` does.
      const EVAL_TENANT_ID = 'eval';
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);

      const pack = await service.resolveActive(EVAL_TENANT_ID);

      expect(pack.packId).toBe('cre');
      expect(pack.version).toBe(1);
    });

    it("should map the tenant's active pack row to a plain MetricPackData", async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce({
        packId: 'cre-fork',
        version: 2,
        label: 'CRE Fork',
        metrics: [],
      });

      const pack = await service.resolveActive(DEFAULT_TENANT_ID);

      expect(pack).toEqual({
        packId: 'cre-fork',
        version: 2,
        label: 'CRE Fork',
        metrics: [],
      });
    });
  });

  describe('listForTenant', () => {
    it('should scope the lookup to the given tenant and sort by packId then version', async () => {
      mockMetricPackModel.find.mockResolvedValueOnce([]);

      await service.listForTenant(DEFAULT_TENANT_ID);

      expect(mockMetricPackModel.find).toHaveBeenCalledWith({ tenantId: DEFAULT_TENANT_ID }, null, {
        sort: { packId: 1, version: 1 },
      });
    });

    // Mapped, not passed through: `toResponseDto` runs `plainToInstance` with
    // `excludeExtraneousValues`, which reads own enumerable properties, and a Mongoose document's
    // `id` is a virtual getter — a document reaching the DTO serialises without it, silently.
    it('should map each stored row to a result carrying a string id', async () => {
      mockMetricPackModel.find.mockResolvedValueOnce([
        {
          _id: { toString: () => 'pack-1' },
          packId: 'cre-fork',
          version: 1,
          status: 'draft',
          label: 'Fork',
          metrics: [capRate],
          parentPackId: 'cre',
          parentVersion: 1,
          createdAt: EPOCH,
        },
      ]);

      const result = await service.listForTenant(DEFAULT_TENANT_ID);

      expect(result).toEqual([
        {
          id: 'pack-1',
          packId: 'cre-fork',
          version: 1,
          status: 'draft',
          label: 'Fork',
          metrics: [capRate],
          parentPackId: 'cre',
          parentVersion: 1,
          createdAt: EPOCH,
        },
      ]);
    });
  });

  describe('createDraft', () => {
    it("should base a version-1 draft on the tenant's active pack when parentVersion is omitted", async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null); // resolveActive -> no active row -> CRE_PACK_V1
      mockMetricPackModel.find.mockResolvedValueOnce([]); // no existing versions under this packId

      mockMetricPackModel.create.mockResolvedValueOnce({
        _id: { toString: () => 'draft-1' },
        packId: 'cre-fork',
        version: 1,
        status: 'draft',
        label: 'Fork',
        metrics: [capRate],
        parentPackId: CRE_PACK_ID,
        parentVersion: CRE_PACK_V1.version,
        createdAt: EPOCH,
      });

      const result = await service.createDraft(
        DEFAULT_TENANT_ID,
        'cre-fork',
        { label: 'Fork', metrics: [capRate] },
        actorId,
      );

      expect(result.version).toBe(1);
      expect(mockMetricPackModel.create).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        packId: 'cre-fork',
        version: 1,
        status: 'draft',
        label: 'Fork',
        metrics: [capRate],
        parentPackId: CRE_PACK_ID,
        parentVersion: CRE_PACK_V1.version,
      });
    });

    it('should base a draft on a named parentVersion within the same packId, versioned one past what already exists', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce({
        packId: 'cre-fork',
        version: 1,
        label: 'Parent',
        metrics: [capRate],
      });
      mockMetricPackModel.find.mockResolvedValueOnce([{ version: 1 }]);

      mockMetricPackModel.create.mockResolvedValueOnce({
        _id: { toString: () => 'draft-2' },
        packId: 'cre-fork',
        version: 2,
        status: 'draft',
        label: 'Fork v2',
        metrics: [capRate],
        parentPackId: 'cre-fork',
        parentVersion: 1,
        createdAt: EPOCH,
      });

      const result = await service.createDraft(
        DEFAULT_TENANT_ID,
        'cre-fork',
        { label: 'Fork v2', metrics: [capRate], parentVersion: 1 },
        actorId,
      );

      expect(result.version).toBe(2);
      expect(mockMetricPackModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ version: 2, parentPackId: 'cre-fork', parentVersion: 1 }),
      );
    });

    it('should throw MetricPackNotFoundException when the named parentVersion does not exist for this tenant', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.createDraft(
          DEFAULT_TENANT_ID,
          'cre-fork',
          { label: 'x', metrics: [], parentVersion: 9 },
          actorId,
        ),
      ).rejects.toThrow(MetricPackNotFoundException);

      expect(mockMetricPackModel.create).not.toHaveBeenCalled();
    });

    it('should map a duplicate-key E11000 error to MetricPackVersionConflictException', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);
      mockMetricPackModel.find.mockResolvedValueOnce([]);
      mockMetricPackModel.create.mockRejectedValueOnce({ code: 11000 });

      await expect(
        service.createDraft(DEFAULT_TENANT_ID, 'cre-fork', { label: 'x', metrics: [] }, actorId),
      ).rejects.toThrow(MetricPackVersionConflictException);
    });

    it('should rethrow a non-duplicate object error unchanged', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);
      mockMetricPackModel.find.mockResolvedValueOnce([]);
      const error = { code: 500, message: 'boom' };
      mockMetricPackModel.create.mockRejectedValueOnce(error);

      await expect(
        service.createDraft(DEFAULT_TENANT_ID, 'cre-fork', { label: 'x', metrics: [] }, actorId),
      ).rejects.toBe(error);
    });

    it('should rethrow a plain Error unchanged (no code property at all)', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);
      mockMetricPackModel.find.mockResolvedValueOnce([]);
      const error = new Error('boom');
      mockMetricPackModel.create.mockRejectedValueOnce(error);

      await expect(
        service.createDraft(DEFAULT_TENANT_ID, 'cre-fork', { label: 'x', metrics: [] }, actorId),
      ).rejects.toBe(error);
    });

    it('should rethrow a non-object thrown value unchanged', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);
      mockMetricPackModel.find.mockResolvedValueOnce([]);
      mockMetricPackModel.create.mockRejectedValueOnce('boom');

      await expect(
        service.createDraft(DEFAULT_TENANT_ID, 'cre-fork', { label: 'x', metrics: [] }, actorId),
      ).rejects.toBe('boom');
    });

    it('should rethrow a null thrown value unchanged', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);
      mockMetricPackModel.find.mockResolvedValueOnce([]);
      mockMetricPackModel.create.mockRejectedValueOnce(null);

      await expect(
        service.createDraft(DEFAULT_TENANT_ID, 'cre-fork', { label: 'x', metrics: [] }, actorId),
      ).rejects.toBe(null);
    });

    it('should record an audit event naming the created draft', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);
      mockMetricPackModel.find.mockResolvedValueOnce([]);
      mockMetricPackModel.create.mockResolvedValueOnce({
        _id: { toString: () => 'draft-1' },
        packId: 'cre-fork',
        version: 1,
        status: 'draft',
        label: 'Fork',
        metrics: [capRate],
        createdAt: EPOCH,
      });

      await service.createDraft(
        DEFAULT_TENANT_ID,
        'cre-fork',
        { label: 'Fork', metrics: [capRate] },
        actorId,
      );

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'metric-packs.draft-created',
        actorId,
        subject: { entityType: 'MetricPack', entityId: 'draft-1' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });
  });

  describe('publish', () => {
    function draftRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'draft',
        label: 'Fork v2',
        metrics: parentMetrics,
        parentPackId: 'cre-fork',
        parentVersion: 1,
        createdAt: EPOCH,
        ...overrides,
      };
    }

    it('should throw MetricPackNotFoundException when the named version does not exist', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackNotFoundException,
      );
      expect(mockMetricPackModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw MetricPackNotDraftException when the version is not currently draft', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(draftRow({ status: 'published' }));

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackNotDraftException,
      );
    });

    it('should throw MetricPackNotFoundException when the draft has no recorded parentPackId', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(draftRow({ parentPackId: undefined }));

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackNotFoundException,
      );
    });

    it('should throw MetricPackNotFoundException when the draft has no recorded parentVersion', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(draftRow({ parentVersion: undefined }));

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackNotFoundException,
      );
    });

    it('should fall back to CRE_PACK_V1 when the stored parent names the code default and no row exists for it', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(
          draftRow({
            metrics: CRE_PACK_V1.metrics,
            parentPackId: CRE_PACK_ID,
            parentVersion: CRE_PACK_V1.version,
          }),
        )
        .mockResolvedValueOnce(null);
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'published',
        label: 'Fork v2',
        metrics: CRE_PACK_V1.metrics,
        createdAt: EPOCH,
      });

      const result = await service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId);

      expect(result.status).toBe('published');
    });

    it('should throw MetricPackNotFoundException when the stored parent no longer exists and is not the code default', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow({ parentPackId: 'other-pack', parentVersion: 1 }))
        .mockResolvedValueOnce(null);

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackNotFoundException,
      );
    });

    it('should throw MetricPackMetricRemovalException for an unacknowledged removal', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow({ metrics: [capRate] })) // sale_price silently dropped
        .mockResolvedValueOnce({
          packId: 'cre-fork',
          version: 1,
          label: 'Parent',
          metrics: parentMetrics,
        });

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackMetricRemovalException,
      );
    });

    it('should throw MetricPackMetricRemovalException for a stale acknowledgment', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow()) // nothing actually removed
        .mockResolvedValueOnce({
          packId: 'cre-fork',
          version: 1,
          label: 'Parent',
          metrics: parentMetrics,
        });

      await expect(
        service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, ['sale_price'], actorId),
      ).rejects.toThrow(MetricPackMetricRemovalException);
    });

    it('should publish successfully when a removal is acknowledged, skipping its frozen-arithmetic check', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow({ metrics: [capRate] }))
        .mockResolvedValueOnce({
          packId: 'cre-fork',
          version: 1,
          label: 'Parent',
          metrics: parentMetrics,
        });
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'published',
        label: 'Fork v2',
        metrics: [capRate],
        createdAt: EPOCH,
      });

      const result = await service.publish(
        DEFAULT_TENANT_ID,
        'cre-fork',
        2,
        ['sale_price'],
        actorId,
      );

      expect(result.status).toBe('published');
    });

    it("should throw MetricPackFrozenArithmeticException when a surviving metric's canonicalUnit changes", async () => {
      const draftMetrics = [{ ...capRate, canonicalUnit: 'percent' }, salePrice];
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow({ metrics: draftMetrics }))
        .mockResolvedValueOnce({
          packId: 'cre-fork',
          version: 1,
          label: 'Parent',
          metrics: parentMetrics,
        });

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackFrozenArithmeticException,
      );
    });

    it('should throw MetricPackFrozenArithmeticException when a unit the parent defined is dropped', async () => {
      const draftMetrics = [
        { ...capRate, units: [{ id: 'ratio', toCanonicalFactor: 1 }] },
        salePrice,
      ];
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow({ metrics: draftMetrics }))
        .mockResolvedValueOnce({
          packId: 'cre-fork',
          version: 1,
          label: 'Parent',
          metrics: parentMetrics,
        });

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackFrozenArithmeticException,
      );
    });

    it('should throw MetricPackFrozenArithmeticException when a unit toCanonicalFactor changes', async () => {
      const draftMetrics = [
        capRate,
        {
          ...salePrice,
          units: [
            { id: 'usd', toCanonicalFactor: 1 },
            { id: 'usd_thousands', toCanonicalFactor: 999 },
          ],
        },
      ];
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow({ metrics: draftMetrics }))
        .mockResolvedValueOnce({
          packId: 'cre-fork',
          version: 1,
          label: 'Parent',
          metrics: parentMetrics,
        });

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackFrozenArithmeticException,
      );
    });

    it('should publish successfully when a new unit is added and nothing existing changes', async () => {
      const draftMetrics = [
        { ...capRate, units: [...capRate.units, { id: 'bps', toCanonicalFactor: 0.0001 }] },
        salePrice,
      ];
      mockMetricPackModel.findOne
        .mockResolvedValueOnce(draftRow({ metrics: draftMetrics }))
        .mockResolvedValueOnce({
          packId: 'cre-fork',
          version: 1,
          label: 'Parent',
          metrics: parentMetrics,
        });
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'published',
        label: 'Fork v2',
        metrics: draftMetrics,
        createdAt: EPOCH,
      });

      const result = await service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId);

      expect(result.status).toBe('published');
    });

    it('should throw MetricPackNotFoundException when the row disappears before the status flip commits', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(draftRow()).mockResolvedValueOnce({
        packId: 'cre-fork',
        version: 1,
        label: 'Parent',
        metrics: parentMetrics,
      });
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId)).rejects.toThrow(
        MetricPackNotFoundException,
      );
    });

    it('should record an audit event naming the published row', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(draftRow()).mockResolvedValueOnce({
        packId: 'cre-fork',
        version: 1,
        label: 'Parent',
        metrics: parentMetrics,
      });
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'published',
        label: 'Fork v2',
        metrics: parentMetrics,
        createdAt: EPOCH,
      });

      await service.publish(DEFAULT_TENANT_ID, 'cre-fork', 2, [], actorId);

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'metric-packs.published',
        actorId,
        subject: { entityType: 'MetricPack', entityId: 'draft-row' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });
  });

  describe('activate', () => {
    it('should throw MetricPackNotFoundException when the named version does not exist', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce(null);

      await expect(service.activate(DEFAULT_TENANT_ID, 'cre-fork', 2, actorId)).rejects.toThrow(
        MetricPackNotFoundException,
      );
    });

    it('should throw MetricPackNotPublishedException when the version is not currently published', async () => {
      mockMetricPackModel.findOne.mockResolvedValueOnce({
        packId: 'cre-fork',
        version: 2,
        status: 'draft',
      });

      await expect(service.activate(DEFAULT_TENANT_ID, 'cre-fork', 2, actorId)).rejects.toThrow(
        MetricPackNotPublishedException,
      );
    });

    it('should activate directly when the tenant has no currently active pack', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce({ packId: 'cre-fork', version: 2, status: 'published' })
        .mockResolvedValueOnce(null);
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'active',
        label: 'Fork v2',
        metrics: [],
        createdAt: EPOCH,
      });

      const result = await service.activate(DEFAULT_TENANT_ID, 'cre-fork', 2, actorId);

      expect(result.status).toBe('active');
      expect(mockMetricPackModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('should demote the previously active pack before promoting the target', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce({ packId: 'cre-fork', version: 2, status: 'published' })
        .mockResolvedValueOnce({ _id: 'old-active', packId: 'cre', version: 1, status: 'active' });
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce({}).mockResolvedValueOnce({
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'active',
        label: 'Fork v2',
        metrics: [],
        createdAt: EPOCH,
      });

      const result = await service.activate(DEFAULT_TENANT_ID, 'cre-fork', 2, actorId);

      expect(result.status).toBe('active');
      expect(mockMetricPackModel.findOneAndUpdate).toHaveBeenNthCalledWith(
        1,
        { _id: 'old-active' },
        { $set: { status: 'published' } },
      );
      expect(mockMetricPackModel.findOneAndUpdate).toHaveBeenNthCalledWith(
        2,
        { tenantId: DEFAULT_TENANT_ID, packId: 'cre-fork', version: 2 },
        { $set: { status: 'active' } },
        { new: true },
      );
    });

    it('should throw MetricPackNotFoundException when the target row disappears before the promote commits', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce({ packId: 'cre-fork', version: 2, status: 'published' })
        .mockResolvedValueOnce(null);
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(service.activate(DEFAULT_TENANT_ID, 'cre-fork', 2, actorId)).rejects.toThrow(
        MetricPackNotFoundException,
      );
    });

    it('should record an audit event naming the activated row', async () => {
      mockMetricPackModel.findOne
        .mockResolvedValueOnce({ packId: 'cre-fork', version: 2, status: 'published' })
        .mockResolvedValueOnce(null);
      mockMetricPackModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: { toString: () => 'draft-row' },
        packId: 'cre-fork',
        version: 2,
        status: 'active',
        label: 'Fork v2',
        metrics: [],
        createdAt: EPOCH,
      });

      await service.activate(DEFAULT_TENANT_ID, 'cre-fork', 2, actorId);

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'metric-packs.activated',
        actorId,
        subject: { entityType: 'MetricPack', entityId: 'draft-row' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });
  });
});
