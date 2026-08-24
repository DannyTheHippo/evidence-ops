import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  TenantMetric,
  TenantMetricDocument,
} from '../../../database/schemas/evidence/tenant-metric/tenant-metric.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { InvalidMetricIdException } from './exceptions/facts.exception';
import { METRIC_IDS } from './metric-ontology';

// Mirrors METRIC_IDS's own naming convention (lowercase snake_case), so a tenant-added measure
// reads no differently from a code-ontology one in any listing that sorts or displays both.
// Exported so `MetricDefinitionRequestDto` (`create-metric-pack-version.request.dto.ts`) validates
// a pack-authored metric id against this same pattern rather than a second copy.
export const METRIC_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function assertValidMetricId(metricId: string): void {
  if (!METRIC_ID_PATTERN.test(metricId)) {
    throw new InvalidMetricIdException(
      `'${metricId}' is not a valid metric id — expected lowercase snake_case`,
    );
  }
}

function isCustomMetricId(metricId: string): boolean {
  return !(METRIC_IDS as readonly string[]).includes(metricId);
}

/** One authored row as the API returns it. `id` is a plain string rather than the document's
 *  ObjectId for the same reason `MetricPolicyResult` documents: a Mongoose document handed
 *  straight to the DTO serialises without `id`, silently, because `excludeExtraneousValues` reads
 *  own enumerable properties and `id` is a virtual getter. */
export interface TenantMetricResult {
  readonly id: string;
  readonly metricId: string;
  readonly label: string;
  readonly isCustom: boolean;
  readonly createdAt: Date;
}

function toTenantMetricResult(row: TenantMetricDocument): TenantMetricResult {
  return {
    id: row._id.toString(),
    metricId: row.metricId,
    label: row.label,
    isCustom: isCustomMetricId(row.metricId),
    createdAt: row.createdAt,
  };
}

/**
 * A tenant's authored labels for measures (`tenant-metric.schema.ts`). A row whose `metricId`
 * matches one of `METRIC_IDS`'s members renames that code-ontology metric's display label; a row
 * whose `metricId` names anything else adds a wholly new catalog entry. Neither operation touches
 * `METRIC_ONTOLOGY` or any field of it — `tolerance` and `unit` decide what counts as a
 * disagreement between two facts, and this collection carries no such fields for either an
 * upsert or a create to populate. Fact extraction (`xlsx-fact-extractor.ts`,
 * `prose-fact-extractor.ts`) and conflict detection (`detect-conflicts.ts`) read
 * `METRIC_ONTOLOGY` directly and never this collection, so a row here can rename or add a
 * measure without ever changing which facts conflict.
 */
@Injectable()
export class TenantMetricsService {
  constructor(
    @InjectModel(TenantMetric.name)
    private readonly tenantMetricModel: Model<TenantMetricDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(TenantMetricsService.name);
  }

  /** Tenant-scoped explicitly on the query, not left to `tenantScopePlugin`'s ALS backstop alone —
   *  same reasoning `MetricPoliciesService.listForTenant`'s identical explicit `tenantId` filter
   *  documents. Sorted by metricId for a deterministic listing. */
  async listForTenant(tenantId: string): Promise<TenantMetricResult[]> {
    const rows = await this.tenantMetricModel.find({ tenantId }, null, { sort: { metricId: 1 } });
    return rows.map((row) => toTenantMetricResult(row));
  }

  /**
   * Upserts one measure's label. `metricId` outside `METRIC_ID_PATTERN` is rejected before any
   * write — a route param has no class-validator decorator to reject it earlier. Uses
   * `findOneAndUpdate` rather than `create`/`findOneAndReplace` because `auditablePlugin` only
   * hooks the former, and because a second `PUT` for the same `(tenantId, metricId)` must update
   * the existing row rather than colliding with the unique index.
   */
  async upsert(
    tenantId: string,
    metricId: string,
    label: string,
    actorId: string,
  ): Promise<TenantMetricResult> {
    assertValidMetricId(metricId);

    const row = await this.tenantMetricModel.findOneAndUpdate(
      { tenantId, metricId },
      { $set: { label } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await this.auditService.record({
      action: 'tenant-metrics.upserted',
      actorId,
      subject: { entityType: 'TenantMetric', entityId: row._id.toString() },
      tenantId,
    });

    this.logger.debug(`Upserted tenant metric label for '${metricId}' in tenant '${tenantId}'`);

    return toTenantMetricResult(row);
  }

  /** Reverts a code-ontology metric to its default label, or removes a tenant-added measure
   *  entirely, by deleting its authored row. Idempotent: a metricId with no authored row is
   *  already at its default (or was never added), so a second call is a no-op rather than an
   *  error — and, having deleted nothing, records no audit row either, since there is no
   *  surviving document to name as the subject. */
  async remove(tenantId: string, metricId: string, actorId: string): Promise<void> {
    assertValidMetricId(metricId);

    const row = await this.tenantMetricModel.findOneAndDelete({ tenantId, metricId });

    if (row) {
      await this.auditService.record({
        action: 'tenant-metrics.removed',
        actorId,
        subject: { entityType: 'TenantMetric', entityId: row._id.toString() },
        tenantId,
      });
    }

    this.logger.debug(`Removed tenant metric label for '${metricId}' in tenant '${tenantId}'`);
  }
}
