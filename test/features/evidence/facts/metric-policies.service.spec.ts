import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import type { MetricPackData } from '../../../../src/database/schemas/evidence/metric-pack/metric-pack.schema';
import { MetricPolicy } from '../../../../src/database/schemas/evidence/metric-policy/metric-policy.schema';
import { UnknownMetricException } from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { MetricPacksService } from '../../../../src/features/evidence/facts/metric-packs.service';
import { MetricPoliciesService } from '../../../../src/features/evidence/facts/metric-policies.service';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { CRE_PACK_V1 } from '../../../../src/features/evidence/facts/packs/cre.pack';
import {
  resolveConflictPolicy,
  type ConflictingFactForResolution,
} from '../../../../src/features/evidence/conflicts/resolve-conflict-policy';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('MetricPoliciesService', () => {
  const EPOCH = new Date('2026-01-01T00:00:00.000Z');
  const actorId = '65f1c2e4a1b2c3d4e5f6a7b9';
  let service: MetricPoliciesService;

  const mockMetricPolicyModel = getMockModel();
  const mockLogger = getMockLogger();
  const mockAuditService = { record: jest.fn() };
  // Every test in this suite runs a tenant with no authored `MetricPack` row unless it re-arms
  // this per-call — `beforeEach` re-arms it to `CRE_PACK_V1` after each `resetAllMocks`, matching
  // `MetricPacksService.resolveActive`'s own fallback and `FactsService`'s identical test setup.
  const mockMetricPacksService = {
    resolveActive: jest.fn(),
  } satisfies Record<keyof Pick<MetricPacksService, 'resolveActive'>, jest.Mock>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricPoliciesService,
        { provide: getModelToken(MetricPolicy.name), useValue: mockMetricPolicyModel },
        { provide: MetricPacksService, useValue: mockMetricPacksService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<MetricPoliciesService>(MetricPoliciesService);
    mockMetricPacksService.resolveActive.mockResolvedValue(CRE_PACK_V1);
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
    it("should throw UnknownMetricException for a metric the tenant's active pack does not define", async () => {
      await expect(service.upsert(DEFAULT_TENANT_ID, 'not_a_metric', {}, actorId)).rejects.toThrow(
        UnknownMetricException,
      );

      expect(mockMetricPolicyModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    // The check is against the tenant's resolved active pack, not the fixed `METRIC_ONTOLOGY`
    // union — a metric a forked pack authors that the code default never defined must be accepted.
    it("should accept a metric the tenant's forked pack defines but METRIC_ONTOLOGY does not", async () => {
      const forkedPack: MetricPackData = {
        packId: 'walkability-fork',
        version: 1,
        label: 'Walkability Fork',
        metrics: [
          ...CRE_PACK_V1.metrics,
          {
            id: 'walkability_score',
            label: 'Walkability Score',
            aliases: ['Walkability Score'],
            valueType: 'percentage',
            canonicalUnit: 'ratio',
            units: [{ id: 'ratio', toCanonicalFactor: 1 }],
            toleranceKind: 'absolute',
            tolerance: 0.01,
          },
        ],
      };
      mockMetricPacksService.resolveActive.mockResolvedValueOnce(forkedPack);
      mockMetricPolicyModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'walkability_score',
      });

      await service.upsert(
        DEFAULT_TENANT_ID,
        'walkability_score',
        { authorityOrder: ['memo'] },
        actorId,
      );

      expect(mockMetricPolicyModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, metric: 'walkability_score' },
        { $set: { authorityOrder: ['memo'] }, $unset: { stalenessWindowMs: '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    // The same check refuses a `METRIC_ONTOLOGY` id once the tenant's active pack has dropped it —
    // proving validation reads the resolved pack, not the fixed compile-time union.
    it("should throw UnknownMetricException for a METRIC_ONTOLOGY metric the tenant's active pack no longer defines", async () => {
      const droppedSalePricePack: MetricPackData = {
        packId: 'trimmed-fork',
        version: 1,
        label: 'Trimmed Fork',
        metrics: CRE_PACK_V1.metrics.filter((metric) => metric.id !== 'sale_price'),
      };
      mockMetricPacksService.resolveActive.mockResolvedValueOnce(droppedSalePricePack);

      await expect(service.upsert(DEFAULT_TENANT_ID, 'sale_price', {}, actorId)).rejects.toThrow(
        UnknownMetricException,
      );

      expect(mockMetricPolicyModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should $set authorityOrder and $unset the omitted stalenessWindowMs', async () => {
      mockMetricPolicyModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'sale_price',
      });

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', { authorityOrder: ['memo'] }, actorId);

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

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', { stalenessWindowMs: 5_000 }, actorId);

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

      await service.upsert(
        DEFAULT_TENANT_ID,
        'sale_price',
        { authorityOrder: ['memo'], stalenessWindowMs: 5_000 },
        actorId,
      );

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

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', {}, actorId);

      expect(mockMetricPolicyModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, metric: 'sale_price' },
        { $unset: { authorityOrder: '', stalenessWindowMs: '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    it('should record an audit event naming the upserted row as the subject', async () => {
      mockMetricPolicyModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'sale_price',
      });

      await service.upsert(DEFAULT_TENANT_ID, 'sale_price', { authorityOrder: ['memo'] }, actorId);

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'metric-policies.upserted',
        actorId,
        subject: { entityType: 'MetricPolicy', entityId: 'policy-1' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });
  });

  describe('remove', () => {
    it("should throw UnknownMetricException for a metric the tenant's active pack does not define", async () => {
      await expect(service.remove(DEFAULT_TENANT_ID, 'not_a_metric', actorId)).rejects.toThrow(
        UnknownMetricException,
      );

      expect(mockMetricPolicyModel.findOneAndDelete).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should delete the tenant-scoped row for the given metric and record an audit event naming it', async () => {
      mockMetricPolicyModel.findOneAndDelete.mockResolvedValueOnce({
        _id: 'policy-1',
        metric: 'sale_price',
      });

      await service.remove(DEFAULT_TENANT_ID, 'sale_price', actorId);

      expect(mockMetricPolicyModel.findOneAndDelete).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        metric: 'sale_price',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'metric-policies.reverted',
        actorId,
        subject: { entityType: 'MetricPolicy', entityId: 'policy-1' },
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    // Idempotent: a metric with no authored row is already at the ontology default, so a second
    // revert is a no-op rather than an error — and there is no surviving document to audit.
    it('should not throw and should not record an audit event when no row exists for the metric', async () => {
      mockMetricPolicyModel.findOneAndDelete.mockResolvedValueOnce(null);

      await expect(
        service.remove(DEFAULT_TENANT_ID, 'sale_price', actorId),
      ).resolves.toBeUndefined();

      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });
});
