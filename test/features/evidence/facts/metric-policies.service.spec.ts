import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { MetricPolicy } from '../../../../src/database/schemas/evidence/metric-policy/metric-policy.schema';
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
});
