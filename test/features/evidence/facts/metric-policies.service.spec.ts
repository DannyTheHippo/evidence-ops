import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { MetricPolicy } from '../../../../src/database/schemas/evidence/metric-policy/metric-policy.schema';
import { UnknownMetricException } from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { MetricPoliciesService } from '../../../../src/features/evidence/facts/metric-policies.service';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import {
  resolveConflictPolicy,
  type ConflictingFactForResolution,
} from '../../../../src/features/evidence/conflicts/resolve-conflict-policy';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('MetricPoliciesService', () => {
  const EPOCH = new Date('2026-01-01T00:00:00.000Z');
  let service: MetricPoliciesService;

  const mockMetricPolicyModel = getMockModel();
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricPoliciesService,
        { provide: getModelToken(MetricPolicy.name), useValue: mockMetricPolicyModel },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<MetricPoliciesService>(MetricPoliciesService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('resolveForTenant', () => {
    it('should scope the lookup to the given tenant', async () => {
      mockMetricPolicyModel.find.mockResolvedValueOnce([]);

      await service.resolveForTenant(DEFAULT_TENANT_ID);

      expect(mockMetricPolicyModel.find).toHaveBeenCalledWith({ tenantId: DEFAULT_TENANT_ID });
    });

    /**
     * The acceptance bar for this collection's introduction: a tenant with zero authored rows
     * must resolve to exactly `METRIC_ONTOLOGY`'s own configuration, metric for metric — including
     * every `resolveConflictPolicy` explanation string a caller would see, so wiring this service
     * into `ConflictsService` (a later step) changes nothing for a tenant who has never authored a
     * policy. Compares both the resolved policy shape and, for every rule `resolveConflictPolicy`
     * can fire, the proposal it produces from the pre-existing `metric?.field ?? default` lookup
     * against the one this service now produces.
     */
    it('should resolve byte-identically to METRIC_ONTOLOGY when the tenant has no policy rows', async () => {
      mockMetricPolicyModel.find.mockResolvedValueOnce([]);

      const policies = await service.resolveForTenant(DEFAULT_TENANT_ID);

      expect(policies.size).toBe(METRIC_ONTOLOGY.length);
      for (const metric of METRIC_ONTOLOGY) {
        expect(policies.get(metric.id)).toEqual({
          authorityOrder: metric.authorityOrder,
          stalenessWindowMs: metric.stalenessWindowMs ?? Number.POSITIVE_INFINITY,
        });
      }

      const scenarios: Record<string, readonly ConflictingFactForResolution[]> = {
        // Two candidates ranked at different points in `authorityOrder` — fires 'authority'.
        authorityWinner: [
          { id: 'fact-pm', sourceClass: 'pm-export', observedAt: new Date('2026-01-01') },
          {
            id: 'fact-spreadsheet',
            sourceClass: 'spreadsheet',
            observedAt: new Date('2026-01-01'),
          },
        ],
        // Two candidates tied at the top authority rank, far enough apart to fire 'recency'.
        recencyWinner: [
          { id: 'fact-old', sourceClass: 'pm-export', observedAt: new Date('2020-01-01') },
          { id: 'fact-new', sourceClass: 'pm-export', observedAt: new Date('2026-01-01') },
        ],
        // A single candidate — always fires 'none' (fewer than two candidates supplied).
        none: [{ id: 'fact-solo', sourceClass: 'pm-export', observedAt: new Date('2026-01-01') }],
      };

      for (const metric of METRIC_ONTOLOGY) {
        const legacyPolicy = {
          authorityOrder: metric.authorityOrder,
          stalenessWindowMs: metric.stalenessWindowMs ?? Number.POSITIVE_INFINITY,
        };
        const foldedPolicy = policies.get(metric.id);
        for (const facts of Object.values(scenarios)) {
          expect(resolveConflictPolicy(facts, foldedPolicy!)).toEqual(
            resolveConflictPolicy(facts, legacyPolicy),
          );
        }
      }
    });

    it("should replace a metric's whole policy with a tenant's authored row, not merge it with the ontology default", async () => {
      // `sale_price` carries neither `authorityOrder` nor `stalenessWindowMs` in the ontology —
      // the override supplies both, and neither should fall back to the ontology's (absent) values.
      mockMetricPolicyModel.find.mockResolvedValueOnce([
        { metric: 'sale_price', authorityOrder: ['memo'], stalenessWindowMs: 5_000 },
      ]);

      const policies = await service.resolveForTenant(DEFAULT_TENANT_ID);

      expect(policies.get('sale_price')).toEqual({
        authorityOrder: ['memo'],
        stalenessWindowMs: 5_000,
      });
    });

    it("should default an authored row's stalenessWindowMs to Infinity when the row leaves it unset, even for a metric the ontology configures a window for", async () => {
      mockMetricPolicyModel.find.mockResolvedValueOnce([
        { metric: 'net_operating_income', authorityOrder: ['crm-export'] },
      ]);

      const policies = await service.resolveForTenant(DEFAULT_TENANT_ID);

      expect(policies.get('net_operating_income')).toEqual({
        authorityOrder: ['crm-export'],
        stalenessWindowMs: Number.POSITIVE_INFINITY,
      });
    });

    it('should leave every metric without an authored row at its ontology default alongside an override for another metric', async () => {
      mockMetricPolicyModel.find.mockResolvedValueOnce([
        { metric: 'sale_price', authorityOrder: ['memo'], stalenessWindowMs: 5_000 },
      ]);

      const policies = await service.resolveForTenant(DEFAULT_TENANT_ID);

      const capRate = METRIC_ONTOLOGY.find((metric) => metric.id === 'cap_rate')!;
      expect(policies.get('cap_rate')).toEqual({
        authorityOrder: capRate.authorityOrder,
        stalenessWindowMs: capRate.stalenessWindowMs,
      });
    });
  });

  describe('listForTenant', () => {
    it('should scope the lookup to the given tenant and sort by metric', async () => {
      mockMetricPolicyModel.find.mockResolvedValueOnce([]);

      await service.listForTenant(DEFAULT_TENANT_ID);

      expect(mockMetricPolicyModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID },
        null,
        { sort: { metric: 1 } },
      );
    });

    // Mapped, not passed through: `toResponseDto` runs `plainToInstance` with
    // `excludeExtraneousValues`, which reads own enumerable properties, and a Mongoose document's
    // `id` is a virtual getter — a document reaching the DTO serialises without it, silently.
    it('should map each stored row to a result carrying a string id', async () => {
      mockMetricPolicyModel.find.mockResolvedValueOnce([
        { _id: 'policy-1', metric: 'sale_price', authorityOrder: ['memo'], createdAt: EPOCH },
      ]);

      const result = await service.listForTenant(DEFAULT_TENANT_ID);

      expect(result).toEqual([
        {
          id: 'policy-1',
          metric: 'sale_price',
          authorityOrder: ['memo'],
          stalenessWindowMs: undefined,
          createdAt: EPOCH,
        },
      ]);
    });
  });

  describe('upsert', () => {
    it('should throw UnknownMetricException for a metric outside METRIC_IDS', async () => {
      await expect(service.upsert(DEFAULT_TENANT_ID, 'not_a_metric' as never, {})).rejects.toThrow(
        UnknownMetricException,
      );

      expect(mockMetricPolicyModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should $set authorityOrder and $unset the omitted stalenessWindowMs', async () => {
      mockMetricPolicyModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'sale_price',
      });

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', { authorityOrder: ['memo'] });

      expect(mockMetricPolicyModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, metric: 'sale_price' },
        { $set: { authorityOrder: ['memo'] }, $unset: { stalenessWindowMs: '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    it('should $set stalenessWindowMs and $unset the omitted authorityOrder', async () => {
      mockMetricPolicyModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'sale_price',
      });

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', { stalenessWindowMs: 5_000 });

      expect(mockMetricPolicyModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, metric: 'sale_price' },
        { $set: { stalenessWindowMs: 5_000 }, $unset: { authorityOrder: '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    it('should $set both fields and omit $unset entirely when both are provided', async () => {
      mockMetricPolicyModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'sale_price',
      });

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', {
        authorityOrder: ['memo'],
        stalenessWindowMs: 5_000,
      });

      expect(mockMetricPolicyModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, metric: 'sale_price' },
        { $set: { authorityOrder: ['memo'], stalenessWindowMs: 5_000 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    // A `PUT` with neither field replaces the whole row with an authority-less,
    // staleness-less one, rather than leaving whatever an earlier `PUT` stored.
    it('should $unset both fields and omit $set entirely when neither is provided', async () => {
      mockMetricPolicyModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'sale_price',
      });

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', {});

      expect(mockMetricPolicyModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, metric: 'sale_price' },
        { $unset: { authorityOrder: '', stalenessWindowMs: '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });
  });

  describe('remove', () => {
    it('should throw UnknownMetricException for a metric outside METRIC_IDS', async () => {
      await expect(service.remove(DEFAULT_TENANT_ID, 'not_a_metric' as never)).rejects.toThrow(
        UnknownMetricException,
      );

      expect(mockMetricPolicyModel.deleteOne).not.toHaveBeenCalled();
    });

    it('should delete the tenant-scoped row for the given metric', async () => {
      mockMetricPolicyModel.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });

      await service.remove(DEFAULT_TENANT_ID, 'sale_price');

      expect(mockMetricPolicyModel.deleteOne).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        metric: 'sale_price',
      });
    });

    // Idempotent: a metric with no authored row is already at the ontology default, so a second
    // revert is a no-op rather than an error.
    it('should not throw when no row exists for the metric', async () => {
      mockMetricPolicyModel.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });

      await expect(service.remove(DEFAULT_TENANT_ID, 'sale_price')).resolves.toBeUndefined();
    });
  });
});
