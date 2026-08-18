import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  MetricPolicy,
  MetricPolicyDocument,
} from '../../../database/schemas/evidence/metric-policy/metric-policy.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { SurvivorshipPolicy } from '../conflicts/resolve-conflict-policy';
import { METRIC_ONTOLOGY, type MetricId } from './metric-ontology';

/**
 * Folds a tenant's authored `MetricPolicy` rows (`metric-policy.schema.ts`) over
 * `METRIC_ONTOLOGY`'s built-in survivorship defaults, one entry per metric the ontology defines.
 * A tenant row for a metric replaces that metric's whole policy — `authorityOrder` and
 * `stalenessWindowMs` together — rather than merging field by field, so an operator who clears a
 * staleness window stays distinguishable from one who never authored a row at all. A metric with
 * no authored row resolves to exactly what a manual `metric?.field ?? default` lookup against
 * `METRIC_ONTOLOGY` already produces, so a tenant that has never authored a policy sees the same
 * survivorship behaviour this collection did not change.
 */
@Injectable()
export class MetricPoliciesService {
  constructor(
    @InjectModel(MetricPolicy.name)
    private readonly metricPolicyModel: Model<MetricPolicyDocument>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(MetricPoliciesService.name);
  }

  /** Tenant-scoped explicitly on the query, not left to `tenantScopePlugin`'s ALS backstop alone —
   *  same reasoning `CanonicalEntityService.resolve`'s identical explicit `tenantId` filter
   *  documents: a survivorship policy is exactly the kind of result that must never silently
   *  widen to another tenant's overrides. */
  async resolveForTenant(tenantId: string): Promise<Map<MetricId, SurvivorshipPolicy>> {
    const rows = await this.metricPolicyModel.find({ tenantId });
    const rowByMetric = new Map(rows.map((row) => [row.metric, row]));

    const policies = new Map<MetricId, SurvivorshipPolicy>();
    for (const metric of METRIC_ONTOLOGY) {
      const override = rowByMetric.get(metric.id);
      policies.set(metric.id, {
        authorityOrder: override ? override.authorityOrder : metric.authorityOrder,
        stalenessWindowMs:
          (override ? override.stalenessWindowMs : metric.stalenessWindowMs) ??
          Number.POSITIVE_INFINITY,
      });
    }

    this.logger.debug(
      `Resolved survivorship policy for ${policies.size} metric(s) in tenant '${tenantId}' (${rowByMetric.size} authored override(s))`,
    );

    return policies;
  }
}
