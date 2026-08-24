import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { DocumentSourceClass } from '../../../database/schemas/evidence/document/document.schema';
import {
  MetricPolicy,
  MetricPolicyDocument,
} from '../../../database/schemas/evidence/metric-policy/metric-policy.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { SurvivorshipPolicy } from '../conflicts/resolve-conflict-policy';
import { UnknownMetricException } from './exceptions/facts.exception';
import { findMetricById } from './metric-ontology';
import { MetricPacksService } from './metric-packs.service';

/**
 * One authored row as the API returns it. `id` is a plain string rather than the document's
 * ObjectId because `toResponseDto` runs `plainToInstance` with `excludeExtraneousValues`, which
 * reads own enumerable properties only — a Mongoose document's `id` is a virtual getter, so a
 * document handed straight to the DTO serialises without it, silently and with no error. Every
 * sibling feature maps to a plain result for the same reason (`ApiKeyResult`).
 */
export interface MetricPolicyResult {
  readonly id: string;
  readonly metric: string;
  readonly authorityOrder?: DocumentSourceClass[];
  readonly stalenessWindowMs?: number;
  readonly createdAt: Date;
}

function toMetricPolicyResult(row: MetricPolicyDocument): MetricPolicyResult {
  return {
    id: row._id.toString(),
    metric: row.metric,
    authorityOrder: row.authorityOrder,
    stalenessWindowMs: row.stalenessWindowMs,
    createdAt: row.createdAt,
  };
}

/**
 * Folds a tenant's authored `MetricPolicy` rows (`metric-policy.schema.ts`) over the tenant's
 * resolved active metric pack's (`MetricPacksService.resolveActive`) built-in survivorship
 * defaults, one entry per metric the resolved pack defines. A tenant row for a metric replaces
 * that metric's whole policy — `authorityOrder` and `stalenessWindowMs` together — rather than
 * merging field by field, so an operator who clears a staleness window stays distinguishable from
 * one who never authored a row at all. A metric with no authored row resolves to exactly what a
 * manual `metric?.field ?? default` lookup against the resolved pack already produces, so a
 * tenant that has never authored a policy — and has never authored a pack either, resolving to
 * the code default `CRE_PACK_V1` — sees the same survivorship behaviour this collection did not
 * change.
 */
@Injectable()
export class MetricPoliciesService {
  constructor(
    @InjectModel(MetricPolicy.name)
    private readonly metricPolicyModel: Model<MetricPolicyDocument>,

    private readonly metricPacksService: MetricPacksService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(MetricPoliciesService.name);
  }

  /** Tenant-scoped explicitly on the query, not left to `tenantScopePlugin`'s ALS backstop alone —
   *  same reasoning `CanonicalEntityService.resolve`'s identical explicit `tenantId` filter
   *  documents: a survivorship policy is exactly the kind of result that must never silently
   *  widen to another tenant's overrides. */
  async resolveForTenant(tenantId: string): Promise<Map<string, SurvivorshipPolicy>> {
    const [rows, pack] = await Promise.all([
      this.metricPolicyModel.find({ tenantId }),
      this.metricPacksService.resolveActive(tenantId),
    ]);
    const rowByMetric = new Map(rows.map((row) => [row.metric, row]));

    const policies = new Map<string, SurvivorshipPolicy>();
    for (const metric of pack.metrics) {
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

  /** The tenant's stored rows, exactly as authored — not `resolveForTenant`'s pack-folded map.
   *  Sorted by metric for a deterministic listing. Mapped to {@link MetricPolicyResult} rather
   *  than returned as documents: see that interface's own comment for why a document reaching the
   *  response DTO loses its `id`. */
  async listForTenant(tenantId: string): Promise<MetricPolicyResult[]> {
    const rows = await this.metricPolicyModel.find({ tenantId }, null, { sort: { metric: 1 } });
    return rows.map((row) => toMetricPolicyResult(row));
  }

  /**
   * Upserts one metric's whole row. `authorityOrder`/`stalenessWindowMs` duplicate-rank and
   * `'unclassified'`/`>= 1` rejection happens on the request DTO before this runs; `metric` itself
   * is checked here, against the tenant's resolved active pack, rather than by a schema-level
   * `enum` — which metric ids are valid is a per-tenant runtime fact, not a fixed compile-time
   * list, so this check fails CLOSED against exactly the allowlist that would otherwise reject the
   * row at write time. This method's remaining job is the whole-row replace: a field omitted from
   * `updates` is `$unset`, not left at whatever an earlier `PUT` stored, so a repeated call can
   * never leave a stale field behind. Uses `findOneAndUpdate` rather than `findOneAndReplace`
   * because `auditablePlugin` only hooks the former — a replace would silently skip the
   * `createdBy`/`updatedBy` stamp.
   */
  async upsert(
    tenantId: string,
    metric: string,
    updates: { authorityOrder?: DocumentSourceClass[]; stalenessWindowMs?: number },
    actorId: string,
  ): Promise<MetricPolicyResult> {
    const pack = await this.metricPacksService.resolveActive(tenantId);
    if (!findMetricById(pack.metrics, metric)) {
      throw new UnknownMetricException(`'${metric}' is not a recognized metric`);
    }

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (updates.authorityOrder !== undefined) {
      $set.authorityOrder = updates.authorityOrder;
    } else {
      $unset.authorityOrder = '';
    }
    if (updates.stalenessWindowMs !== undefined) {
      $set.stalenessWindowMs = updates.stalenessWindowMs;
    } else {
      $unset.stalenessWindowMs = '';
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) {
      update.$set = $set;
    }
    if (Object.keys($unset).length > 0) {
      update.$unset = $unset;
    }

    const policy = await this.metricPolicyModel.findOneAndUpdate({ tenantId, metric }, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });

    await this.auditService.record({
      action: 'metric-policies.upserted',
      actorId,
      subject: { entityType: 'MetricPolicy', entityId: policy._id.toString() },
      tenantId,
    });

    this.logger.debug(`Upserted metric policy for '${metric}' in tenant '${tenantId}'`);

    return toMetricPolicyResult(policy);
  }

  /** Reverts a metric to the tenant's active pack default by deleting its authored row. Idempotent:
   *  a metric with no authored row is already at the default, so a second call is a no-op rather
   *  than an error — and, having deleted nothing, records no audit row either, since there is no
   *  surviving document to name as the subject. `metric` is checked against the tenant's resolved
   *  active pack for the same reason `upsert` checks it there rather than via a schema `enum`. */
  async remove(tenantId: string, metric: string, actorId: string): Promise<void> {
    const pack = await this.metricPacksService.resolveActive(tenantId);
    if (!findMetricById(pack.metrics, metric)) {
      throw new UnknownMetricException(`'${metric}' is not a recognized metric`);
    }

    const policy = await this.metricPolicyModel.findOneAndDelete({ tenantId, metric });

    if (policy) {
      await this.auditService.record({
        action: 'metric-policies.reverted',
        actorId,
        subject: { entityType: 'MetricPolicy', entityId: policy._id.toString() },
        tenantId,
      });
    }

    this.logger.debug(`Reverted metric policy for '${metric}' in tenant '${tenantId}' to default`);
  }
}
