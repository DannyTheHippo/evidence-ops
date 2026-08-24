import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CRE_PACK_ID,
  MetricPack,
  MetricPackDocument,
  type MetricDefinition,
  type MetricPackData,
  type MetricPackStatus,
} from '../../../database/schemas/evidence/metric-pack/metric-pack.schema';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { RescanConflictsWorkflowInput } from '../../../workflows/types';
import { WorkflowRunsService } from '../workflow-runs/workflow-runs.service';
import { diffDetectionRelevantMetrics } from './diff-metric-packs';
import {
  MetricPackFrozenArithmeticException,
  MetricPackMetricRemovalException,
  MetricPackNotDraftException,
  MetricPackNotFoundException,
  MetricPackNotPublishedException,
  MetricPackVersionConflictException,
} from './exceptions/facts.exception';
import { CRE_PACK_V1 } from './packs/cre.pack';

/**
 * `rescanConflicts` — the Temporal workflow type name in `src/workflows/rescan-conflicts.workflow.ts`
 * — is not exported as a runtime value from `src/workflows/**` (types only, across the determinism
 * fence). Duplicated here rather than imported, the same reasoning `ConflictsService`'s own
 * `RESOLVE_CONFLICT_WORKFLOW_TYPE` documents.
 */
const RESCAN_CONFLICTS_WORKFLOW_TYPE = 'rescanConflicts';

function toMetricPackData(pack: MetricPackDocument): MetricPackData {
  return {
    packId: pack.packId,
    version: pack.version,
    label: pack.label,
    metrics: pack.metrics,
  };
}

/** One pack version as the API returns it. `id` is a plain string rather than the document's
 *  ObjectId for the same reason `MetricPolicyResult` documents: a Mongoose document handed
 *  straight to the DTO serialises without `id`, silently, because `excludeExtraneousValues` reads
 *  own enumerable properties and `id` is a virtual getter. */
export interface MetricPackResult {
  readonly id: string;
  readonly packId: string;
  readonly version: number;
  readonly status: MetricPackStatus;
  readonly label: string;
  readonly metrics: readonly MetricDefinition[];
  readonly parentPackId?: string;
  readonly parentVersion?: number;
  readonly createdAt: Date;
}

function toMetricPackResult(row: MetricPackDocument): MetricPackResult {
  return {
    id: row._id.toString(),
    packId: row.packId,
    version: row.version,
    status: row.status,
    label: row.label,
    metrics: row.metrics,
    parentPackId: row.parentPackId,
    parentVersion: row.parentVersion,
    createdAt: row.createdAt,
  };
}

/**
 * Resolves the metric pack a tenant's detection and survivorship logic should use, and gives an
 * operator the authoring lifecycle to build one: `createDraft` → `publish` → `activate`. Extraction,
 * conflict detection and policy validation all read `resolveActive`; only the three admin-only
 * lifecycle methods below ever write to this collection.
 */
@Injectable()
export class MetricPacksService {
  constructor(
    @InjectModel(MetricPack.name)
    private readonly metricPackModel: Model<MetricPackDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly workflowRunsService: WorkflowRunsService,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(MetricPacksService.name);
  }

  /** Tenant-scoped explicitly on the query, not left to `tenantScopePlugin`'s ALS backstop alone —
   *  same reasoning `MetricPoliciesService.resolveForTenant`'s identical explicit `tenantId`
   *  filter documents: a resolved pack is exactly the kind of result that must never silently
   *  widen to another tenant's rows. `metric_packs_tenantId_active_unique` guarantees at most one
   *  match. */
  async resolveActive(tenantId: string): Promise<MetricPackData> {
    const active = await this.metricPackModel.findOne({ tenantId, status: 'active' });

    if (!active) {
      this.logger.debug(
        `No active metric pack for tenant '${tenantId}'; resolved to code default '${CRE_PACK_V1.packId}' v${CRE_PACK_V1.version}`,
      );
      return CRE_PACK_V1;
    }

    this.logger.debug(
      `Resolved active metric pack '${active.packId}' v${active.version} for tenant '${tenantId}'`,
    );
    return toMetricPackData(active);
  }

  /** Every version the tenant has authored, across every packId, sorted for a stable listing. */
  async listForTenant(tenantId: string): Promise<MetricPackResult[]> {
    const rows = await this.metricPackModel.find({ tenantId }, null, {
      sort: { packId: 1, version: 1 },
    });
    return rows.map((row) => toMetricPackResult(row));
  }

  /**
   * Creates a new draft under `packId`, versioned one past whatever this tenant has already
   * authored for it (starting at 1 for a packId with no rows yet). The parent to diff against at
   * publish time is resolved now, from `parentVersion` when given or from `resolveActive` when
   * not, and stamped onto the row — see `MetricPack.parentPackId`'s own doc comment for why it is
   * captured here rather than re-resolved at publish time.
   */
  async createDraft(
    tenantId: string,
    packId: string,
    input: { label: string; metrics: MetricDefinition[]; parentVersion?: number },
    actorId: string,
  ): Promise<MetricPackResult> {
    const parent = await this.resolveParent(tenantId, packId, input.parentVersion);

    const existingVersions = await this.metricPackModel.find(
      { tenantId, packId },
      { version: 1 },
      { sort: { version: -1 }, limit: 1 },
    );
    const version = (existingVersions[0]?.version ?? 0) + 1;

    let draft: MetricPackDocument;
    try {
      draft = await this.metricPackModel.create({
        tenantId,
        packId,
        version,
        status: 'draft',
        label: input.label,
        metrics: input.metrics,
        parentPackId: parent.packId,
        parentVersion: parent.version,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new MetricPackVersionConflictException(
          `Pack '${packId}' v${version} was just created by a concurrent request for this tenant`,
          error,
        );
      }
      throw error;
    }

    await this.auditService.record({
      action: 'metric-packs.draft-created',
      actorId,
      subject: { entityType: 'MetricPack', entityId: draft._id.toString() },
      tenantId,
    });

    this.logger.debug(`Created draft '${packId}' v${version} for tenant '${tenantId}'`);

    return toMetricPackResult(draft);
  }

  /**
   * Freezes a draft: refuses unless every metric the parent defined is either still present or
   * explicitly acknowledged as removed, and unless every metric surviving from the parent keeps an
   * unchanged `canonicalUnit` and every one of the parent's unit factors — the frozen-arithmetic
   * check `assertFrozenArithmetic` enforces, and the single most important rule this method runs.
   * A `tolerance`/`toleranceKind` edit needs neither check: it only governs the *next* rescan, so a
   * version stamp on the fact it produces is already honest about which tolerance ran.
   */
  async publish(
    tenantId: string,
    packId: string,
    version: number,
    acknowledgeRemovedMetricIds: readonly string[],
    actorId: string,
  ): Promise<MetricPackResult> {
    const draft = await this.findVersionOrThrow(tenantId, packId, version);
    if (draft.status !== 'draft') {
      throw new MetricPackNotDraftException(
        `Pack '${packId}' v${version} is '${draft.status}', not 'draft' — only a draft can be ` +
          'published, and a published version is immutable',
      );
    }

    const parent = await this.resolveStoredParent(tenantId, draft);
    this.assertNoUnacknowledgedRemovals(
      parent,
      draft.metrics,
      acknowledgeRemovedMetricIds,
      packId,
      version,
    );
    this.assertFrozenArithmetic(parent, draft.metrics, packId, version);

    const published = await this.metricPackModel.findOneAndUpdate(
      { tenantId, packId, version },
      { $set: { status: 'published' } },
      { new: true },
    );
    if (!published) {
      throw new MetricPackNotFoundException(`Pack '${packId}' v${version} no longer exists`);
    }

    await this.auditService.record({
      action: 'metric-packs.published',
      actorId,
      subject: { entityType: 'MetricPack', entityId: published._id.toString() },
      tenantId,
    });

    this.logger.debug(`Published pack '${packId}' v${version} for tenant '${tenantId}'`);

    return toMetricPackResult(published);
  }

  /**
   * Promotes a published version to active, demoting whatever this tenant's previously active
   * pack was back to `published` first — `metric_packs_tenantId_active_unique` allows at most one
   * active row per tenant, so the demote has to commit before the promote can. Flips status only:
   * a following step reruns conflict detection across this tenant's `ExtractedFact`s against the
   * newly active pack, triggered from here once the status flip below commits.
   */
  async activate(
    tenantId: string,
    packId: string,
    version: number,
    actorId: string,
  ): Promise<MetricPackResult> {
    const target = await this.findVersionOrThrow(tenantId, packId, version);
    if (target.status !== 'published') {
      throw new MetricPackNotPublishedException(
        `Pack '${packId}' v${version} is '${target.status}', not 'published' — only a published ` +
          'version can be activated',
      );
    }

    const currentActive = await this.metricPackModel.findOne({ tenantId, status: 'active' });
    if (currentActive) {
      await this.metricPackModel.findOneAndUpdate(
        { _id: currentActive._id },
        { $set: { status: 'published' } },
      );
    }

    const activated = await this.metricPackModel.findOneAndUpdate(
      { tenantId, packId, version },
      { $set: { status: 'active' } },
      { new: true },
    );
    if (!activated) {
      throw new MetricPackNotFoundException(`Pack '${packId}' v${version} no longer exists`);
    }

    await this.auditService.record({
      action: 'metric-packs.activated',
      actorId,
      subject: { entityType: 'MetricPack', entityId: activated._id.toString() },
      tenantId,
    });

    this.logger.debug(`Activated pack '${packId}' v${version} for tenant '${tenantId}'`);

    // The seam `diff-metric-packs.ts`'s own doc comment names: rescans only the metrics whose
    // detection-relevant configuration actually changed against whatever pack was active before
    // this promote, never the tenant's whole metric set. `currentActive` is the pre-demote row read
    // above; a tenant with none falls back to the code default, matching `resolveActive`'s own
    // fallback so a first-ever activation diffs against exactly what extraction already read.
    const previous = currentActive ? toMetricPackData(currentActive) : CRE_PACK_V1;
    const changedMetricIds = diffDetectionRelevantMetrics(previous, toMetricPackData(activated));

    if (changedMetricIds.length > 0) {
      const handle = await this.workflowEngine.start(RESCAN_CONFLICTS_WORKFLOW_TYPE, {
        tenantId,
        metricIds: changedMetricIds,
      } satisfies RescanConflictsWorkflowInput);

      await this.workflowRunsService.create({
        workflowId: handle.id,
        workflowType: 'rescan-conflicts',
        status: handle.status,
        tenantId,
      });

      this.logger.debug(
        `Started rescanConflicts workflow '${handle.id}' for pack '${packId}' v${version}, ` +
          `metrics: ${changedMetricIds.join(', ')}`,
      );
    }

    return toMetricPackResult(activated);
  }

  /** Public wrapper of `findVersionOrThrow`, returning the plain `MetricPackData` shape rather
   *  than the Mongoose document — `ConflictsService.previewPackActivation` (`conflicts.service.ts`)
   *  is the caller, resolving the draft/published version an operator wants to preview before it is
   *  ever activated. Reachable across the module boundary because `ConflictsModule` imports
   *  `FactsModule`, never the reverse (see `ConflictsModule`'s own doc comment). */
  async findVersion(tenantId: string, packId: string, version: number): Promise<MetricPackData> {
    return toMetricPackData(await this.findVersionOrThrow(tenantId, packId, version));
  }

  private async findVersionOrThrow(
    tenantId: string,
    packId: string,
    version: number,
  ): Promise<MetricPackDocument> {
    const row = await this.metricPackModel.findOne({ tenantId, packId, version });
    if (!row) {
      throw new MetricPackNotFoundException(
        `Pack '${packId}' v${version} does not exist for this tenant`,
      );
    }
    return row;
  }

  /**
   * Resolves the diff baseline for a new draft: the named `parentVersion` within `packId` when
   * given, or the tenant's currently active pack otherwise — which may belong to a different
   * packId entirely (forking the code default `CRE_PACK_V1` or another lineage into this one). A
   * named `parentVersion` is always looked up within this same `packId`, never `CRE_PACK_ID`'s —
   * `packId`'s own schema validator rejects `'cre'` for every tenant-authored row, so a fallback to
   * the code default here would be unreachable through any request this controller accepts.
   */
  private async resolveParent(
    tenantId: string,
    packId: string,
    parentVersion: number | undefined,
  ): Promise<MetricPackData> {
    if (parentVersion === undefined) {
      return this.resolveActive(tenantId);
    }

    const parentRow = await this.metricPackModel.findOne({
      tenantId,
      packId,
      version: parentVersion,
    });
    if (!parentRow) {
      throw new MetricPackNotFoundException(
        `Parent version ${parentVersion} of pack '${packId}' does not exist for this tenant`,
      );
    }
    return toMetricPackData(parentRow);
  }

  /** Resolves the parent a draft was actually created against, from the row's own stamped
   *  `parentPackId`/`parentVersion` rather than re-deriving it — see `MetricPack.parentPackId`'s
   *  own doc comment for why the two can diverge by the time `publish` runs. */
  private async resolveStoredParent(
    tenantId: string,
    draft: MetricPackDocument,
  ): Promise<MetricPackData> {
    if (draft.parentPackId === undefined || draft.parentVersion === undefined) {
      // Every draft this service creates stamps a parent (`resolveParent` always resolves one,
      // even for a tenant with nothing authored, via the code default) — only a row predating this
      // field could reach here. The frozen-arithmetic and metric-removal checks below are safety
      // gates, not measurements, so a missing baseline fails CLOSED rather than silently skipping
      // them by comparing the draft against itself.
      throw new MetricPackNotFoundException(
        `Pack '${draft.packId}' v${draft.version} has no recorded parent version to publish against`,
      );
    }

    const parentRow = await this.metricPackModel.findOne({
      tenantId,
      packId: draft.parentPackId,
      version: draft.parentVersion,
    });
    if (parentRow) {
      return toMetricPackData(parentRow);
    }
    if (draft.parentPackId === CRE_PACK_ID && draft.parentVersion === CRE_PACK_V1.version) {
      return CRE_PACK_V1;
    }
    throw new MetricPackNotFoundException(
      `Parent version ${draft.parentVersion} of pack '${draft.parentPackId}' no longer exists`,
    );
  }

  /** Refuses a publish that would drop a parent metric the request does not acknowledge, and a
   *  request that acknowledges a metric the draft still defines or the parent never defined —
   *  either would leave `acknowledgeRemovedMetricIds` an inaccurate record of what actually
   *  changed. */
  private assertNoUnacknowledgedRemovals(
    parent: MetricPackData,
    draftMetrics: readonly MetricDefinition[],
    acknowledged: readonly string[],
    packId: string,
    version: number,
  ): void {
    const draftIds = new Set(draftMetrics.map((metric) => metric.id));
    const removedIds = parent.metrics.map((metric) => metric.id).filter((id) => !draftIds.has(id));
    const removedIdSet = new Set(removedIds);

    const unacknowledged = removedIds.filter((id) => !acknowledged.includes(id));
    if (unacknowledged.length > 0) {
      throw new MetricPackMetricRemovalException(
        `Publishing pack '${packId}' v${version} would drop metric(s) ${unacknowledged.join(', ')} ` +
          'present in the parent version — acknowledge the removal explicitly or restore the metric',
      );
    }

    const stale = acknowledged.filter((id) => !removedIdSet.has(id));
    if (stale.length > 0) {
      throw new MetricPackMetricRemovalException(
        `acknowledgeRemovedMetricIds names ${stale.join(', ')}, which the draft still defines or ` +
          'the parent version never defined',
      );
    }
  }

  /**
   * `normalizeFactValue` re-multiplies every stored fact's raw `{amount, unit}` against the
   * *active* pack's factors on every scan — the active pack's `canonicalUnit` and factors
   * reinterpret facts stamped under every earlier version, identically and silently. A tolerance
   * edit reads forward, so a version stamp on the fact it produces is honest about which tolerance
   * ran; a factor edit reads backward, so no stamp can make it honest. Refuses a surviving metric
   * (present in both parent and draft) whose `canonicalUnit` changed, or whose draft `units` drops
   * or changes the `toCanonicalFactor` of any unit id the parent defined — a new unit id may
   * always be added.
   */
  private assertFrozenArithmetic(
    parent: MetricPackData,
    draftMetrics: readonly MetricDefinition[],
    packId: string,
    version: number,
  ): void {
    const draftById = new Map(draftMetrics.map((metric) => [metric.id, metric]));

    for (const parentMetric of parent.metrics) {
      const draftMetric = draftById.get(parentMetric.id);
      if (!draftMetric) {
        continue;
      }

      if (draftMetric.canonicalUnit !== parentMetric.canonicalUnit) {
        throw new MetricPackFrozenArithmeticException(
          `Metric '${parentMetric.id}' changes canonicalUnit from '${parentMetric.canonicalUnit}' ` +
            `to '${draftMetric.canonicalUnit}' in pack '${packId}' v${version} — a conversion factor ` +
            'reads backward over every fact already stamped under an earlier version, so no version ' +
            'stamp can make this edit honest',
        );
      }

      const draftUnitsById = new Map(draftMetric.units.map((unit) => [unit.id, unit]));
      for (const parentUnit of parentMetric.units) {
        const draftUnit = draftUnitsById.get(parentUnit.id);
        if (!draftUnit || draftUnit.toCanonicalFactor !== parentUnit.toCanonicalFactor) {
          throw new MetricPackFrozenArithmeticException(
            `Unit '${parentUnit.id}' of metric '${parentMetric.id}' changes toCanonicalFactor in ` +
              `pack '${packId}' v${version} — see canonicalUnit's refusal above for why a factor ` +
              'edit cannot be made honest by a version stamp',
          );
        }
      }
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
