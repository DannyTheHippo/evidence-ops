import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { TenantMetric } from '../../../../src/database/schemas/evidence/tenant-metric/tenant-metric.schema';
import {
  detectConflicts,
  type FactForConflictScan,
} from '../../../../src/features/evidence/conflicts/detect-conflicts';
import { InvalidMetricIdException } from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { TenantMetricsService } from '../../../../src/features/evidence/facts/tenant-metrics.service';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

function fact(overrides: Partial<FactForConflictScan> = {}): FactForConflictScan {
  return {
    id: 'fact-id',
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    value: { amount: 5.25, unit: 'percent' },
    ...overrides,
  };
}

describe('TenantMetricsService', () => {
  const EPOCH = new Date('2026-01-01T00:00:00.000Z');
  const actorId = '65f1c2e4a1b2c3d4e5f6a7b9';
  let service: TenantMetricsService;

  const mockTenantMetricModel = getMockModel();
  const mockLogger = getMockLogger();
  const mockAuditService = { record: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantMetricsService,
        { provide: getModelToken(TenantMetric.name), useValue: mockTenantMetricModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<TenantMetricsService>(TenantMetricsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('listForTenant', () => {
    it('should scope the lookup to the given tenant and sort by metricId', async () => {
      mockTenantMetricModel.find.mockResolvedValueOnce([]);

      await service.listForTenant(DEFAULT_TENANT_ID);

      expect(mockTenantMetricModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID },
        null,
        { sort: { metricId: 1 } },
      );
    });

    // Mapped, not passed through: `toResponseDto` runs `plainToInstance` with
    // `excludeExtraneousValues`, which reads own enumerable properties, and a Mongoose document's
    // `id` is a virtual getter — a document reaching the DTO serialises without it, silently.
    it('should map a code-ontology metricId row to isCustom: false', async () => {
      mockTenantMetricModel.find.mockResolvedValueOnce([
        { _id: 'row-1', metricId: 'cap_rate', label: 'Capitalization Rate', createdAt: EPOCH },
      ]);

      const result = await service.listForTenant(DEFAULT_TENANT_ID);

      expect(result).toEqual([
        {
          id: 'row-1',
          metricId: 'cap_rate',
          label: 'Capitalization Rate',
          isCustom: false,
          createdAt: EPOCH,
        },
      ]);
    });

    it('should map a metricId outside METRIC_IDS to isCustom: true', async () => {
      mockTenantMetricModel.find.mockResolvedValueOnce([
        { _id: 'row-2', metricId: 'walk_score', label: 'Walk Score', createdAt: EPOCH },
      ]);

      const result = await service.listForTenant(DEFAULT_TENANT_ID);

      expect(result[0]).toEqual({
        id: 'row-2',
        metricId: 'walk_score',
        label: 'Walk Score',
        isCustom: true,
        createdAt: EPOCH,
      });
    });
  });

  describe('upsert', () => {
    it('should throw InvalidMetricIdException for a malformed metricId and write nothing', async () => {
      await expect(
        service.upsert(DEFAULT_TENANT_ID, 'Not A Metric!', 'Some Label', actorId),
      ).rejects.toThrow(InvalidMetricIdException);

      expect(mockTenantMetricModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should rename a code-ontology metric by upserting its label', async () => {
      mockTenantMetricModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'row-1',
        metricId: 'cap_rate',
        label: 'Capitalization Rate',
        createdAt: EPOCH,
      });

      const result = await service.upsert(
        DEFAULT_TENANT_ID,
        'cap_rate',
        'Capitalization Rate',
        actorId,
      );

      expect(mockTenantMetricModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, metricId: 'cap_rate' },
        { $set: { label: 'Capitalization Rate' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      expect(result.isCustom).toBe(false);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'tenant-metrics.upserted',
        actorId,
        subject: { entityType: 'TenantMetric', entityId: 'row-1' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    it('should add a new measure for a metricId outside METRIC_IDS', async () => {
      mockTenantMetricModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'row-2',
        metricId: 'walk_score',
        label: 'Walk Score',
        createdAt: EPOCH,
      });

      const result = await service.upsert(DEFAULT_TENANT_ID, 'walk_score', 'Walk Score', actorId);

      expect(result.isCustom).toBe(true);
    });

    /**
     * The acceptance bar this collection exists under: renaming a measure must never change what
     * a conflict scan does with it. `TenantMetricsService.upsert` writes only to `tenant_metrics`;
     * `detectConflicts` reads `METRIC_ONTOLOGY` directly and never this collection, so the same
     * facts must produce byte-identical conflicts before and after a rename.
     */
    it('should not alter conflict detection when a metric is renamed', async () => {
      const facts = [
        fact({ id: 'xlsx-fact', value: { amount: 5.25, unit: 'percent' } }),
        fact({ id: 'pdf-fact', value: { amount: 6.1, unit: 'percent' } }),
      ];
      const before = detectConflicts(facts, METRIC_ONTOLOGY);

      mockTenantMetricModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'row-1',
        metricId: 'cap_rate',
        label: 'Capitalization Rate (renamed)',
        createdAt: EPOCH,
      });
      await service.upsert(DEFAULT_TENANT_ID, 'cap_rate', 'Capitalization Rate (renamed)', actorId);

      const after = detectConflicts(facts, METRIC_ONTOLOGY);

      expect(after).toEqual(before);
      expect(after.conflicts).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('should throw InvalidMetricIdException for a malformed metricId and delete nothing', async () => {
      await expect(service.remove(DEFAULT_TENANT_ID, 'Not A Metric!', actorId)).rejects.toThrow(
        InvalidMetricIdException,
      );

      expect(mockTenantMetricModel.findOneAndDelete).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should delete the tenant-scoped row for the given metricId and record an audit event naming it', async () => {
      mockTenantMetricModel.findOneAndDelete.mockResolvedValueOnce({
        _id: 'row-1',
        metricId: 'cap_rate',
      });

      await service.remove(DEFAULT_TENANT_ID, 'cap_rate', actorId);

      expect(mockTenantMetricModel.findOneAndDelete).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        metricId: 'cap_rate',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'tenant-metrics.removed',
        actorId,
        subject: { entityType: 'TenantMetric', entityId: 'row-1' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    // Idempotent: a metricId with no authored row is already at its default (or was never
    // added), so a second revert is a no-op rather than an error — and there is no surviving
    // document to audit.
    it('should not throw and should not record an audit event when no row exists for the metricId', async () => {
      mockTenantMetricModel.findOneAndDelete.mockResolvedValueOnce(null);

      await expect(service.remove(DEFAULT_TENANT_ID, 'cap_rate', actorId)).resolves.toBeUndefined();

      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });
});
