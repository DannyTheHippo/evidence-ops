import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { QueryFilter } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  Conflict,
  ConflictDocument,
  type ConflictResolutionOutcome,
  type ConflictRuleFired,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  Document,
  DocumentDocument,
  type DocumentSourceClass,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
  type FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { MetricPackData } from '../../../database/schemas/evidence/metric-pack/metric-pack.schema';
import {
  Approval,
  type ApprovalDocument,
} from '../../../database/schemas/workflow/approval/approval.schema';
import { approvalTimeoutCounter } from '../../../providers/telemetry/domain-metrics';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import type { ResolveConflictWorkflowInput } from '../../../workflows/types';
import { diffDetectionRelevantMetrics } from '../facts/diff-metric-packs';
import { MetricPacksService } from '../facts/metric-packs.service';
import { MetricPoliciesService } from '../facts/metric-policies.service';
import {
  WorkflowRunsService,
  type WorkflowRunResult,
} from '../workflow-runs/workflow-runs.service';
import type { ListConflictsRequestDto } from './dtos/request/list-conflicts.request.dto';
import type { ConflictValueShape } from './dtos/response/conflict.response.dto';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';
import {
  detectConflicts,
  groupKey,
  type ConflictCandidate,
  type FactForConflictScan,
} from './detect-conflicts';
import {
  ConflictNotFoundException,
  ConflictResolutionAlreadyPendingException,
  InvalidConflictResolutionException,
} from './exceptions/conflicts.exception';
import {
  loadFactSourceEnrichment,
  loadSourceClassByFactId,
  type FactSourceEnrichment,
} from './load-source-class-by-fact-id';
import {
  resolveConflictPolicy,
  type ConflictingFactForResolution,
  type ResolveConflictProposal,
  type SurvivorshipPolicy,
} from './resolve-conflict-policy';

export interface ConflictScanResult {
  readonly conflictsCreated: number;
  /** Facts `detectConflicts` could not normalize (an unrecognized unit) and dropped from this
   * scan — also logged individually at `warn` (see `scanForConflicts`), but surfaced here too so a
   * caller (the `eval` harness, a future admin surface) can assert on or alert on the count without
   * scraping logs. Zero on every run where every fact's unit was recognized. */
  readonly skippedFactCount: number;
}

export interface ConflictRetractionResult {
  readonly conflictsRetracted: number;
}

/** One metric's counts from `previewPackActivation` — how many `Conflict` rows a real activation
 *  of the previewed version would create or retract for this metric, computed without writing
 *  either. */
export interface PackActivationPreviewMetricResult {
  readonly metricId: string;
  readonly wouldCreate: number;
  readonly wouldRetract: number;
}

/** Only the metrics `diffDetectionRelevantMetrics` reports changed appear here — see
 *  `previewPackActivation`'s own doc comment for why a labels-only draft previews as `{ metrics: [] }`. */
export interface PackActivationPreviewResult {
  readonly metrics: readonly PackActivationPreviewMetricResult[];
}

/** One side of an open `Conflict`, projected for `GroundingGateService.verify`'s
 * `conflicting_evidence` outcome — shaped to match `conflictingValueSchema`
 * (`../qa/contracts/answer.contract.ts`) field-for-field. */
export interface ConflictedFactValue {
  readonly value: number;
  readonly unit: string;
  readonly sourceChunkId: string;
}

/** An open `Conflict`'s fact key plus every one of its `factIds`' current values — not just the
 * fact touched by a request's retrieved chunk, since `conflictingEvidenceOutcomeSchema` requires
 * the *whole* disagreement (`values.min(2)`), not one side of it. `conflictId` is the underlying
 * `Conflict._id` — outside `conflictingEvidenceOutcomeSchema` itself (that schema is what the
 * server persists as `Answer.outcome`), but is what `activities.ts`'s `groundingCheck` threads
 * through to `Answer.conflictIds` so a `conflicting_evidence` answer names the record that caused
 * it, not just its values. */
export interface ConflictedFactGroup {
  readonly conflictId: string;
  readonly factKey: FactKey;
  readonly values: readonly ConflictedFactValue[];
}

/** One `ExtractedFact` side of a conflict being considered for resolution — `factId` is the field
 * `ConflictedFactValue` deliberately omits (that type only ever needs to say *where* a value came
 * from, not which `ExtractedFact._id` it is); resolution needs the id to validate and record a
 * proposed winner. */
export interface ConflictResolutionValue {
  readonly factId: string;
  readonly value: number;
  readonly unit: string;
  readonly sourceChunkId: string;
}

/** Everything `resolveConflict` (`resolve-conflict.workflow.ts`) needs to build a human-readable
 * approval request and, later, record the winner — loaded and validated in one call by
 * `loadConflictForResolution` so the workflow never requests approval for a proposal that can't be
 * honored. */
export interface ConflictResolutionCandidate {
  readonly conflictId: string;
  readonly factKey: FactKey;
  readonly winningFactId: string;
  readonly values: readonly ConflictResolutionValue[];
}

export interface RecordConflictResolutionInput {
  readonly conflictId: string;
  readonly outcome: ConflictResolutionOutcome;
  /** Present only when `outcome === 'resolved'` — the `ExtractedFact._id` a human approved as the
   * correct value. */
  readonly winningFactId?: string;
  readonly decidedBy?: string;
  readonly reason?: string;
  readonly tenantId: string;
  /** The survivorship policy's proposal, captured by `requestResolution` at approval-request time
   * and carried through `ResolveConflictWorkflowInput` — never recomputed here (see
   * `recordResolution`'s own doc comment). Absent only when replaying a `resolveConflict` execution
   * that started before this capture existed. */
  readonly ruleFired?: ConflictRuleFired;
  readonly proposedWinnerFactId?: string;
}

export interface RecordConflictResolutionResult {
  readonly conflictId: string;
  readonly outcome: ConflictResolutionOutcome;
}

export interface RequestConflictResolutionInput {
  readonly conflictId: string;
  readonly winningFactId: string;
  readonly actorId: string;
  /** Threaded into `ResolveConflictWorkflowInput.requestedBy` and, eventually,
   *  `Approval.requestedBy` — the identity shown to the human deciding the proposal. An email when
   *  the caller has one to give (`ConflictsController` reads it from the session; the MCP surface
   *  reads it from the verified PAT's `ToolExecutionContext.email`), otherwise the account id. */
  readonly requestedBy: string;
  /** Which surface proposed this resolution — `'api'` for the interactive REST path, `'mcp'` for
   *  `request_resolution` (`src/mcp/mcp-tools.ts`). Threaded to `ResolveConflictWorkflowInput
   *  .requestedByOrigin` and rendered into the approval summary a reviewer reads, so "a colleague
   *  proposed this" and "an AI client holding a PAT proposed this" are never indistinguishable —
   *  see ADR-0016 § Approvals. Optional: an absent origin renders as an unlabeled proposal in the
   *  summary rather than defaulting to either surface. */
  readonly origin?: 'api' | 'mcp';
  readonly tenantId: string;
}

/**
 * `resolveConflict` — the Temporal workflow type name in `src/workflows/resolve-conflict.workflow.ts`
 * — is not exported as a runtime value from `src/workflows/**` (types only, across the determinism
 * fence). Duplicated here rather than imported, the same reasoning `qa.service.ts`'s
 * `ANSWER_QUESTION_WORKFLOW_TYPE` and `documents.service.ts`'s
 * `INGEST_DOCUMENT_VERSION_WORKFLOW_TYPE` already document.
 */
const RESOLVE_CONFLICT_WORKFLOW_TYPE = 'resolveConflict';

@Injectable()
export class ConflictsService {
  constructor(
    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    @InjectModel(Approval.name)
    private readonly approvalModel: Model<ApprovalDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly workflowRunsService: WorkflowRunsService,

    private readonly metricPoliciesService: MetricPoliciesService,
    private readonly metricPacksService: MetricPacksService,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ConflictsService.name);
  }

  /**
   * Audit subject: a paginated list has no single conflict to attach the event to, so the
   * requesting user stands in as the subject rather than a fabricated ObjectId that would
   * dangle with no referent.
   */
  async list(
    dto: ListConflictsRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<ConflictResponseDto>> {
    const filter = { tenantId, ...(dto.status ? { status: dto.status } : {}) };

    const [conflicts, count] = await Promise.all([
      this.conflictModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.conflictModel.countDocuments(filter),
    ]);

    let factById = new Map<string, ExtractedFactDocument>();
    let factEnrichmentByFactId = new Map<string, FactSourceEnrichment>();
    // Resolved once for the whole page, not once per conflict: `MetricPoliciesService
    // .resolveForTenant` is a query, and a page of N conflicts sharing (as most do) only a
    // handful of distinct metrics must not turn into N policy reads.
    let policies = new Map<string, SurvivorshipPolicy>();
    // Resolved once for the whole page too, for the same reason — every row's `stale` flag
    // (`toConflictDto`) compares against this one resolution rather than a per-row read.
    let activePack: MetricPackData | undefined;
    if (conflicts.length > 0) {
      const everyFactId = [
        ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
      ].map((id) => new Types.ObjectId(id));
      const facts = await this.extractedFactModel.find({ _id: { $in: everyFactId }, tenantId });
      factById = new Map(facts.map((fact) => [fact._id.toString(), fact]));
      // `loadFactSourceEnrichment`, not `loadSourceClassByFactId` — a listed conflict's
      // `ConflictValueShape.withdrawn` needs the same join's withdrawal signal alongside
      // sourceClass, and this is the one call that already pays for the join's two queries.
      factEnrichmentByFactId = await loadFactSourceEnrichment(
        this.documentVersionModel,
        this.documentModel,
        facts,
        tenantId,
      );
      policies = await this.metricPoliciesService.resolveForTenant(tenantId);
      activePack = await this.metricPacksService.resolveActive(tenantId);
    }

    await this.auditService.record({
      action: 'conflicts.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return {
      docs: conflicts.map((conflict) =>
        // `activePack` is always resolved by this point when `conflicts.length > 0` — the only
        // condition under which this callback ever runs — same reasoning `factEnrichmentByFactId
        // .get(...)`'s own `as` cast above documents for an equivalent "always present here" case.
        this.toConflictDto(
          conflict,
          factById,
          factEnrichmentByFactId,
          policies,
          activePack as MetricPackData,
        ),
      ),
      count,
    };
  }

  /**
   * Scans `ExtractedFact`s for one tenant, groups by `(entity, metric, period)`, and persists a
   * `Conflict` for each group whose normalized values disagree by more than the tenant's active
   * metric pack's tolerance for that metric (`MetricPacksService.resolveActive`, resolved once per
   * call — every candidate this call detects, and every `Conflict` it inserts, is judged and
   * stamped against that one resolution).
   *
   * Two paths over the identical `detectConflicts` core, chosen by whether `factKeys` is
   * `undefined` (not by emptiness — `factKeys: []` is a real "this ingest produced zero facts"
   * result, and must run the cheap incremental path with an empty `$in`, never silently fall back
   * to a full scan):
   *
   * - **Incremental** (`factKeys` given): a document re-ingest re-scans only the groups its own
   *   facts belong to — via `groupKeyNormalized`, the denormalized case-insensitive grouping key
   *   `migrations/0013-fact-group-key-normalized.ts` backfilled and indexed alongside
   *   `{tenantId, status, groupKeyNormalized}` for the idempotency check below. This is the path
   *   `ingest-document-version.workflow.ts` calls on every ingest.
   * - **Full scan** (`factKeys` omitted): every `ExtractedFact` for the tenant, streamed via a
   *   Mongoose cursor rather than one `find()` materializing the whole collection — the
   *   maintenance/eval path (`npm run eval`, an admin re-scan), not the per-ingest hot path.
   *
   * `scanForConflictsByMetrics` below is a third path, metric-scoped rather than fact-scoped — it
   * shares this method's incremental tail (`scanGroupKeys`) rather than duplicating it.
   *
   * Idempotent by group, not by run: a group with an `open` `Conflict` always blocks a new one. A
   * `resolved`/`dismissed` `Conflict` blocks a new one only when its `factIds` exactly match the
   * candidate's — the disagreement is unchanged, so there is nothing new to decide. A
   * `resolved`/`dismissed` `Conflict` whose `factIds` differ from the candidate's — the group grew
   * with a genuinely new fact — does not block: new evidence is a new decision, not a repeat of an
   * old one.
   */
  async scanForConflicts(
    tenantId: string,
    factKeys?: readonly FactKey[],
  ): Promise<ConflictScanResult> {
    const pack = await this.metricPacksService.resolveActive(tenantId);

    if (factKeys !== undefined) {
      const groupKeys = [...new Set(factKeys.map(groupKey))];
      return this.scanGroupKeys(tenantId, groupKeys, pack);
    }

    const facts: FactForConflictScan[] = [];
    const cursor = this.extractedFactModel.find({ tenantId }, { factKey: 1, value: 1 }).cursor();
    for await (const fact of cursor) {
      facts.push(this.toFactForScan(fact));
    }
    return this.detectAndPersist(tenantId, facts, { tenantId }, pack);
  }

  /**
   * Scans only the groups whose `factKey.metric` is one of `metricIds` — the seam a future
   * metric-pack activation trigger calls with exactly the metric ids a new version actually
   * changed (a tolerance, a unit factor), never the whole tenant. Resolves `metricIds` to their
   * `groupKeyNormalized` values via one `distinct` query, then shares `scanForConflicts`'s own
   * incremental tail (`scanGroupKeys`) rather than a second copy of it — the same reasoning that
   * method's own doc comment gives for sharing `detectConflicts`. `metricIds: []` resolves no
   * groups and rescans nothing, the same "real empty result, not an unset param" contract
   * `scanForConflicts`'s `factKeys: []` already keeps — a pack version that only renamed labels or
   * added aliases changed no metric's detection config, so the caller passes an empty set and this
   * method does no work at all.
   */
  async scanForConflictsByMetrics(
    tenantId: string,
    metricIds: readonly string[],
  ): Promise<ConflictScanResult> {
    const pack = await this.metricPacksService.resolveActive(tenantId);
    const groupKeys = await this.extractedFactModel.distinct('groupKeyNormalized', {
      tenantId,
      'factKey.metric': { $in: [...metricIds] },
    });
    return this.scanGroupKeys(tenantId, groupKeys, pack);
  }

  private toFactForScan(fact: {
    _id: Types.ObjectId;
    factKey: FactKey;
    value: FactValue;
  }): FactForConflictScan {
    return { id: fact._id.toString(), factKey: fact.factKey, value: fact.value };
  }

  /** Shared tail of `scanForConflicts`'s `factKeys` branch and `scanForConflictsByMetrics`: load
   * every fact in the given `groupKeyNormalized` set and hand it to `detectAndPersist`, scoped to
   * that identical set for the existing-conflict idempotency check. */
  private async scanGroupKeys(
    tenantId: string,
    groupKeys: readonly string[],
    pack: MetricPackData,
  ): Promise<ConflictScanResult> {
    const facts = await this.extractedFactModel.find(
      { tenantId, groupKeyNormalized: { $in: groupKeys } },
      { factKey: 1, value: 1 },
    );
    return this.detectAndPersist(
      tenantId,
      facts.map((fact) => this.toFactForScan(fact)),
      { tenantId, groupKeyNormalized: { $in: groupKeys } },
      pack,
    );
  }

  private async detectAndPersist(
    tenantId: string,
    facts: readonly FactForConflictScan[],
    existingConflictScope: QueryFilter<ConflictDocument>,
    pack: MetricPackData,
  ): Promise<ConflictScanResult> {
    const { conflicts: candidates, skipped } = detectConflicts(facts, pack.metrics);

    // A silently-dropped fact is a fact that can never conflict — the quiet correctness loss this
    // whole scan exists to prevent — so every skip is logged individually with the context (fact
    // id, metric, unit) needed to act on it, not just counted.
    for (const { fact, reason } of skipped) {
      this.logger.warn(
        `Skipped fact '${fact.id}' (metric '${fact.factKey.metric}', unit '${fact.value.unit}') from conflict detection: ${reason}`,
      );
    }

    if (candidates.length === 0) {
      this.logger.debug(`No conflicts detected for tenant '${tenantId}'`);
      return { conflictsCreated: 0, skippedFactCount: skipped.length };
    }

    // Every existing conflict in `existingConflictScope`, any status — not scoped to `open` — so
    // the filter below can both skip a group with an `open` conflict and skip a group whose most
    // recent `resolved`/`dismissed` conflict already covers the exact same `factIds` set. A
    // `resolved`/`dismissed` conflict whose `factIds` differ from a candidate's does not count as
    // a match for that candidate — see this method's own idempotency comment on `scanForConflicts`.
    const existingConflicts = await this.conflictModel.find(existingConflictScope);
    const newCandidates = this.filterNewCandidates(candidates, existingConflicts);

    if (newCandidates.length === 0) {
      this.logger.debug(`All detected conflicts for tenant '${tenantId}' are already handled`);
      return { conflictsCreated: 0, skippedFactCount: skipped.length };
    }

    await this.conflictModel.insertMany(
      newCandidates.map((candidate) => ({
        factKey: candidate.factKey,
        groupKeyNormalized: groupKey(candidate.factKey),
        factIds: candidate.factIds.map((id) => new Types.ObjectId(id)),
        magnitude: candidate.magnitude,
        magnitudeUnit: candidate.magnitudeUnit,
        packId: pack.packId,
        packVersion: pack.version,
        status: 'open',
        tenantId,
      })),
    );

    this.logger.debug(`Created ${newCandidates.length} conflicts for tenant '${tenantId}'`);

    return { conflictsCreated: newCandidates.length, skippedFactCount: skipped.length };
  }

  /** Shared by `detectAndPersist` and `previewPackActivation`'s would-create half: which of
   *  `candidates` are genuinely new against `existingConflicts` — not covered by an `open` conflict
   *  for the same group, nor by a `resolved`/`dismissed` one whose `factIds` exactly match. See
   *  `scanForConflicts`'s own idempotency comment for why a closed conflict only counts as a match
   *  on an exact `factIds` tie. Pure: reads nothing, writes nothing, so it is safe for a
   *  preview-only caller to reuse unchanged. */
  private filterNewCandidates(
    candidates: readonly ConflictCandidate[],
    existingConflicts: readonly ConflictDocument[],
  ): ConflictCandidate[] {
    const openGroupKeys = new Set<string>();
    const closedFactIdSetsByGroupKey = new Map<string, Set<string>[]>();
    for (const conflict of existingConflicts) {
      const key = groupKey(conflict.factKey);
      if (conflict.status === 'open') {
        openGroupKeys.add(key);
        continue;
      }
      const sets = closedFactIdSetsByGroupKey.get(key) ?? [];
      sets.push(new Set(conflict.factIds.map((id) => id.toString())));
      closedFactIdSetsByGroupKey.set(key, sets);
    }

    return candidates.filter((candidate) => {
      const key = groupKey(candidate.factKey);
      if (openGroupKeys.has(key)) {
        return false;
      }
      const closedFactIdSets = closedFactIdSetsByGroupKey.get(key);
      if (!closedFactIdSets) {
        return true;
      }
      return !closedFactIdSets.some(
        (factIdSet) =>
          factIdSet.size === candidate.factIds.length &&
          candidate.factIds.every((factId) => factIdSet.has(factId)),
      );
    });
  }

  /**
   * Retracts every `open` conflict, scoped to `metricIds`, that the tenant's active metric pack no
   * longer considers a disagreement — the complement of `scanForConflictsByMetrics`: that method
   * creates conflicts a pack version newly detects, this one closes conflicts a pack version no
   * longer detects. Re-evaluates each candidate group's CURRENT facts (every `ExtractedFact`
   * sharing the conflict's `groupKeyNormalized`, not just the conflict's own stored `factIds`)
   * against the resolved pack — a group that grew since the conflict opened must be judged as it
   * stands now, or a live disagreement among the newer facts could be silently closed alongside
   * the settled one. Writes `status: 'dismissed'` with `resolution.outcome: 'retracted'`, never
   * `'resolved'` — see `ConflictResolutionOutcome`'s own doc comment for why a machine retraction
   * must not land in `MeasuresService.conflictsResolved`. Never deletes and never reopens, the same
   * `superseded` precedent `DocumentsService.remove` sets for its own machine-driven status flip.
   *
   * Skips a conflict carrying a pending resolution `Approval` — the other half of the race
   * `recordResolution`'s own guard closes: even skipped here, a reviewer who approved a proposal
   * before this run started must not have that approval overwritten by, nor race, a retraction
   * that started before their decision landed.
   */
  async retractConflicts(
    tenantId: string,
    metricIds: readonly string[],
  ): Promise<ConflictRetractionResult> {
    if (metricIds.length === 0) {
      return { conflictsRetracted: 0 };
    }

    const pack = await this.metricPacksService.resolveActive(tenantId);
    const toRetract = await this.findRetractableConflicts(tenantId, metricIds, pack);
    if (toRetract.length === 0) {
      return { conflictsRetracted: 0 };
    }

    await this.conflictModel.updateMany(
      { _id: { $in: toRetract.map((conflict) => conflict._id) } },
      {
        status: 'dismissed',
        resolution: {
          outcome: 'retracted',
          resolvedAt: new Date(),
          packId: pack.packId,
          packVersion: pack.version,
        },
      },
    );

    this.logger.debug(
      `Retracted ${toRetract.length} conflict(s) for tenant '${tenantId}' under pack '${pack.packId}' v${pack.version}`,
    );

    return { conflictsRetracted: toRetract.length };
  }

  /**
   * Which currently-`open` conflicts, scoped to `metricIds`, no longer disagree when their CURRENT
   * facts are re-evaluated against `pack` — the shared computation behind `retractConflicts` (which
   * writes `status: 'dismissed'` for every row this returns) and `previewPackActivation`'s
   * would-retract half (which only counts them, against the draft pack instead of the active one).
   * Excludes a conflict carrying a pending resolution `Approval` on every caller — see
   * `retractConflicts`'s own doc comment for why that guard must never be skipped, including in a
   * preview: a preview promising a retraction a real activation would actually refuse would be
   * dishonest about what commit will do.
   */
  private async findRetractableConflicts(
    tenantId: string,
    metricIds: readonly string[],
    pack: MetricPackData,
  ): Promise<ConflictDocument[]> {
    const openConflicts = await this.conflictModel.find({
      tenantId,
      status: 'open',
      'factKey.metric': { $in: [...metricIds] },
    });
    if (openConflicts.length === 0) {
      return [];
    }

    const pendingApprovals = await this.approvalModel.find(
      {
        tenantId,
        state: 'pending',
        'subject.entityType': 'Conflict',
        'subject.entityId': { $in: openConflicts.map((conflict) => conflict._id) },
      },
      { 'subject.entityId': 1 },
    );
    const pendingConflictIds = new Set(
      pendingApprovals.map((approval) => approval.subject.entityId.toString()),
    );

    const groupKeys = [...new Set(openConflicts.map((conflict) => conflict.groupKeyNormalized))];
    const facts = await this.extractedFactModel.find(
      { tenantId, groupKeyNormalized: { $in: groupKeys } },
      { factKey: 1, value: 1 },
    );
    const { conflicts: stillConflicting } = detectConflicts(
      facts.map((fact) => this.toFactForScan(fact)),
      pack.metrics,
    );
    const stillConflictingGroupKeys = new Set(
      stillConflicting.map((candidate) => groupKey(candidate.factKey)),
    );

    return openConflicts.filter(
      (conflict) =>
        !stillConflictingGroupKeys.has(conflict.groupKeyNormalized) &&
        !pendingConflictIds.has(conflict._id.toString()),
    );
  }

  /**
   * The honest analogue of `ResolutionBacktestService`'s hindsight table, run BEFORE a version is
   * ever activated rather than after: detects what `scanForConflictsByMetrics`/`retractConflicts`
   * would do if `packId` v`version` were promoted right now, against the tenant's existing facts —
   * without ever writing a `Conflict` row. Scoped to `diffDetectionRelevantMetrics(activePack,
   * draftPack)`, the identical set `MetricPacksService.activate` would name to `rescanConflicts`, so
   * a labels-only draft previews as `{ metrics: [] }`, the same "nothing would change" answer
   * activating it would produce.
   */
  async previewPackActivation(
    tenantId: string,
    packId: string,
    version: number,
  ): Promise<PackActivationPreviewResult> {
    const draftPack = await this.metricPacksService.findVersion(tenantId, packId, version);
    const activePack = await this.metricPacksService.resolveActive(tenantId);
    const changedMetricIds = diffDetectionRelevantMetrics(activePack, draftPack);

    if (changedMetricIds.length === 0) {
      return { metrics: [] };
    }

    const wouldCreateByMetric = await this.previewWouldCreate(
      tenantId,
      changedMetricIds,
      draftPack,
    );
    const wouldRetractByMetric = await this.previewWouldRetract(
      tenantId,
      changedMetricIds,
      draftPack,
    );

    const metricIds = [
      ...new Set([...wouldCreateByMetric.keys(), ...wouldRetractByMetric.keys()]),
    ].sort();

    return {
      metrics: metricIds.map((metricId) => ({
        metricId,
        wouldCreate: wouldCreateByMetric.get(metricId) ?? 0,
        wouldRetract: wouldRetractByMetric.get(metricId) ?? 0,
      })),
    };
  }

  /** The would-create half of `previewPackActivation`: which of the candidates `detectConflicts`
   *  finds under `draftPack`, scoped to `metricIds`, are genuinely new — mirrors
   *  `scanForConflictsByMetrics`'s own query shape exactly, stopping short of `insertMany`. */
  private async previewWouldCreate(
    tenantId: string,
    metricIds: readonly string[],
    draftPack: MetricPackData,
  ): Promise<Map<string, number>> {
    const groupKeys = await this.extractedFactModel.distinct('groupKeyNormalized', {
      tenantId,
      'factKey.metric': { $in: [...metricIds] },
    });
    const facts = await this.extractedFactModel.find(
      { tenantId, groupKeyNormalized: { $in: groupKeys } },
      { factKey: 1, value: 1 },
    );
    const { conflicts: candidates } = detectConflicts(
      facts.map((fact) => this.toFactForScan(fact)),
      draftPack.metrics,
    );
    if (candidates.length === 0) {
      return new Map();
    }

    const existingConflicts = await this.conflictModel.find({
      tenantId,
      groupKeyNormalized: { $in: groupKeys },
    });
    const newCandidates = this.filterNewCandidates(candidates, existingConflicts);

    const counts = new Map<string, number>();
    for (const candidate of newCandidates) {
      const metricId = candidate.factKey.metric;
      counts.set(metricId, (counts.get(metricId) ?? 0) + 1);
    }
    return counts;
  }

  /** The would-retract half of `previewPackActivation`: `findRetractableConflicts` evaluated
   *  against `draftPack` instead of the tenant's currently active pack. */
  private async previewWouldRetract(
    tenantId: string,
    metricIds: readonly string[],
    draftPack: MetricPackData,
  ): Promise<Map<string, number>> {
    const toRetract = await this.findRetractableConflicts(tenantId, metricIds, draftPack);
    const counts = new Map<string, number>();
    for (const conflict of toRetract) {
      const metricId = conflict.factKey.metric;
      counts.set(metricId, (counts.get(metricId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Open conflicts touched by a request's retrieved evidence, scoped to `chunkIds` and
   * `tenantId`. "Touched" means at least one of the conflict's `factIds` was extracted from one of
   * `chunkIds` — a request must never be able to force `conflicting_evidence` off a conflict in a
   * document it never retrieved, so this deliberately does not scan the tenant's whole `conflicts`
   * collection. `resolved`/`dismissed` conflicts are excluded for the same reason
   * `scanForConflicts` treats them as already handled.
   */
  async findConflictedFactGroupsForChunks(
    chunkIds: readonly string[],
    tenantId: string,
  ): Promise<ConflictedFactGroup[]> {
    if (chunkIds.length === 0) {
      return [];
    }

    const touchedFacts = await this.extractedFactModel.find(
      { chunkId: { $in: [...chunkIds] }, tenantId },
      { _id: 1 },
    );
    if (touchedFacts.length === 0) {
      return [];
    }

    const conflicts = await this.conflictModel.find({
      tenantId,
      status: 'open',
      factIds: { $in: touchedFacts.map((fact) => fact._id) },
    });
    if (conflicts.length === 0) {
      return [];
    }

    const everyFactId = [
      ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
    ].map((id) => new Types.ObjectId(id));
    const conflictingFacts = await this.extractedFactModel.find({
      _id: { $in: everyFactId },
      tenantId,
    });
    const factById = new Map(conflictingFacts.map((fact) => [fact._id.toString(), fact]));

    return conflicts.map((conflict) => {
      const values: ConflictedFactValue[] = [];
      for (const id of conflict.factIds) {
        const fact = factById.get(id.toString());
        if (!fact) {
          continue;
        }
        values.push({
          value: fact.value.amount,
          unit: fact.value.unit,
          sourceChunkId: fact.chunkId,
        });
      }

      if (values.length < conflict.factIds.length) {
        // A `Conflict.factIds` reference that no longer resolves to an `ExtractedFact` is a
        // data-integrity fault, not a normal degradation path (mirrors
        // `EvidenceRetrievalService`'s deleted-version throw) — `conflictingEvidenceOutcomeSchema`
        // requires >= 2 `values`, and silently persisting a group short of the conflict's real
        // factIds would emit either a schema-invalid outcome or a `conflicting_evidence` answer
        // that understates a real disagreement.
        throw new InternalServerErrorException(
          `Conflict '${conflict._id.toString()}' references ${conflict.factIds.length} fact(s), but only ${values.length} still resolve to an ExtractedFact`,
        );
      }

      return {
        conflictId: conflict._id.toString(),
        factKey: {
          entity: conflict.factKey.entity,
          metric: conflict.factKey.metric,
          period: conflict.factKey.period,
        },
        values,
      };
    });
  }

  /**
   * Loads the `open` conflict `resolveConflict` (`resolve-conflict.workflow.ts`) is gating, and
   * validates the caller's proposed `winningFactId` before any approval is requested — there is no
   * point asking a human to approve a proposal that doesn't even reference one of this conflict's
   * own facts. Fails closed on every invalid state: missing conflict, a conflict already decided
   * by an earlier resolution attempt (`status !== 'open'`), an unknown/malformed `winningFactId`,
   * or one that isn't among `conflict.factIds`. A `factIds` reference that no longer resolves to an
   * `ExtractedFact` is a data-integrity fault, not a normal branch — same reasoning
   * `findConflictedFactGroupsForChunks` applies to its own identical check above.
   */
  async loadConflictForResolution(
    conflictId: string,
    winningFactId: string,
    tenantId: string,
  ): Promise<ConflictResolutionCandidate> {
    if (!Types.ObjectId.isValid(conflictId)) {
      throw new ConflictNotFoundException(`Conflict '${conflictId}' not found`);
    }

    const conflict = await this.conflictModel.findOne({ _id: conflictId, tenantId });
    if (!conflict) {
      throw new ConflictNotFoundException(`Conflict '${conflictId}' not found`);
    }

    if (conflict.status !== 'open') {
      throw new InvalidConflictResolutionException(
        `Conflict '${conflictId}' is '${conflict.status}', not 'open' — it cannot be resolved again`,
      );
    }

    if (
      !Types.ObjectId.isValid(winningFactId) ||
      !conflict.factIds.some((factId) => factId.equals(winningFactId))
    ) {
      throw new InvalidConflictResolutionException(
        `'${winningFactId}' is not one of conflict '${conflictId}''s disagreeing facts`,
      );
    }

    const facts = await this.extractedFactModel.find({
      _id: { $in: conflict.factIds },
      tenantId,
    });
    if (facts.length < conflict.factIds.length) {
      throw new InternalServerErrorException(
        `Conflict '${conflictId}' references ${conflict.factIds.length} fact(s), but only ${facts.length} still resolve to an ExtractedFact`,
      );
    }

    return {
      conflictId: conflict._id.toString(),
      factKey: {
        entity: conflict.factKey.entity,
        metric: conflict.factKey.metric,
        period: conflict.factKey.period,
      },
      // Normalized to the canonical lowercase hex form: `Types.ObjectId.isValid` and
      // `factId.equals()` above both accept uppercase hex, but `values[].factId` below is always
      // `_id.toString()` (lowercase). A caller's uppercase `winningFactId` would otherwise survive
      // validation here and then fail every downstream `===` comparison against `factId`.
      winningFactId: new Types.ObjectId(winningFactId).toString(),
      values: facts.map((fact) => ({
        factId: fact._id.toString(),
        value: fact.value.amount,
        unit: fact.value.unit,
        sourceChunkId: fact.chunkId,
      })),
    };
  }

  /**
   * D3 of the approvals milestone: `POST /conflicts/:id/resolution-requests`. Validates the
   * proposal via `loadConflictForResolution` (the same fail-closed checks `resolveConflict`'s own
   * `loadConflict` activity applies) before ever starting a workflow — no point starting a
   * `resolveConflict` execution, and no point creating a `WorkflowRun` row for it, for a proposal
   * that can't be honored. Also refuses when a pending `Approval` already exists for this conflict
   * (`ConflictResolutionAlreadyPendingException`) — a conflict stays `open` for its entire
   * 24-hour approval wait, so without this check every call in that window starts its own
   * `resolveConflict` execution and its own pending row, each independently approvable; two
   * approvals could then name different `winningFactId`s and both reach `recordResolution`.
   * `workflowEngine.start` never chooses the winner (see `ResolveConflictWorkflowInput`'s own doc
   * comment); it only starts the gate. The returned `WorkflowRunResult` — from
   * `WorkflowRunsService.create`, this collection's first writer — gives the caller an id to poll
   * `GET /workflow-runs/:id` with.
   *
   * `computeProposalForConflict` runs here, once, before the workflow's 24-hour approval wait
   * begins — the resulting `ruleFired`/`proposedWinnerFactId` travel through
   * `ResolveConflictWorkflowInput` to `recordResolution` unchanged (see that method's own doc
   * comment for why it never recomputes them itself). `MetricPoliciesService.resolveForTenant` is
   * called after the pending-duplicate guard, not before — a request that fails validation or
   * finds a pending approval never pays for a policy read it won't use.
   */
  async requestResolution(input: RequestConflictResolutionInput): Promise<WorkflowRunResult> {
    const tenantId = input.tenantId;

    const candidate = await this.loadConflictForResolution(
      input.conflictId,
      input.winningFactId,
      tenantId,
    );

    const alreadyPending = await this.approvalModel.exists({
      tenantId,
      state: 'pending',
      'subject.entityType': 'Conflict',
      'subject.entityId': new Types.ObjectId(input.conflictId),
    });
    if (alreadyPending) {
      throw new ConflictResolutionAlreadyPendingException(
        `Conflict '${input.conflictId}' already has a pending resolution approval`,
      );
    }

    const policies = await this.metricPoliciesService.resolveForTenant(tenantId);
    const proposal = await this.computeProposalForConflict(
      {
        factIds: candidate.values.map((value) => new Types.ObjectId(value.factId)),
        factKey: candidate.factKey,
      },
      tenantId,
      policies,
    );

    const handle = await this.workflowEngine.start(RESOLVE_CONFLICT_WORKFLOW_TYPE, {
      conflictId: input.conflictId,
      winningFactId: input.winningFactId,
      requestedBy: input.requestedBy,
      requestedByOrigin: input.origin,
      tenantId,
      ruleFired: proposal.ruleFired,
      proposedWinnerFactId:
        proposal.ruleFired === 'none' ? undefined : proposal.proposedWinnerFactId,
    } satisfies ResolveConflictWorkflowInput);

    const run = await this.workflowRunsService.create({
      workflowId: handle.id,
      workflowType: 'resolve-conflict',
      status: handle.status,
      tenantId,
    });

    await this.auditService.record({
      action: 'conflicts.resolution_requested',
      actorId: input.actorId,
      subject: { entityType: 'Conflict', entityId: input.conflictId },
      tenantId,
    });

    this.logger.debug(
      `Started resolveConflict workflow '${handle.id}' for conflict '${input.conflictId}'`,
    );

    return run;
  }

  /**
   * Persists the outcome `resolveConflict` reached after waking from its approval wait — called
   * exactly once per workflow run, on every branch (`resolved`, `rejected`, `timed_out`), so a
   * conflict that was gated on but never got a timely human answer still carries a durable record
   * of the attempt. Only `outcome: 'resolved'` also flips `status` to `'resolved'`:
   * `rejected`/`timed_out` leave the conflict `open` (a rejection or a timeout is not a
   * resolution), but the attempt is still worth recording so a reviewer can see what already
   * happened. Fails closed on a missing conflict — same reasoning as
   * `AnswerPersistenceService.persist`: a missing row here means the id this activity was called
   * with doesn't match a real conflict, and silently no-op-ing would hide that.
   *
   * `ruleFired`/`followedProposal` are never recomputed here — `input.ruleFired` and
   * `input.proposedWinnerFactId` are exactly what `requestResolution` captured before the
   * workflow's 24-hour approval wait began (carried through `ResolveConflictWorkflowInput`), so a
   * reclassification or any other change to the conflict's facts during that wait can't retroactively
   * rewrite what was actually proposed to the reviewer. `followedProposal` is set only when the
   * outcome is `resolved` and a proposal was actually captured (`input.proposedWinnerFactId` is
   * present) — `rejected`/`timed_out`, a `'none'` proposal, and a stale pre-capture history (see
   * `ResolveConflictWorkflowInput`'s own doc comment) all leave it absent rather than fabricate a
   * `false`.
   *
   * Refuses, on every outcome, a conflict `retractConflicts` already dismissed as `'retracted'` —
   * the other half of the race that method's own guard closes. `loadConflictForResolution` checked
   * `status === 'open'` only at request time, up to 24 hours before this call; a rescan can retract
   * the conflict in between, and this activity runs regardless of that (`resolveConflict` never
   * re-checks status before waking). Without this guard a late `resolved`/`rejected`/`timed_out`
   * write would silently overwrite the retraction's provenance even though `status` itself never
   * moves off `'dismissed'`.
   */
  async recordResolution(
    input: RecordConflictResolutionInput,
  ): Promise<RecordConflictResolutionResult> {
    const tenantId = input.tenantId;
    if (!Types.ObjectId.isValid(input.conflictId)) {
      throw new ConflictNotFoundException(`Conflict '${input.conflictId}' not found`);
    }

    const conflict = await this.conflictModel.findOne({ _id: input.conflictId, tenantId });
    if (!conflict) {
      throw new ConflictNotFoundException(`Conflict '${input.conflictId}' not found`);
    }

    if (conflict.status === 'dismissed' && conflict.resolution?.outcome === 'retracted') {
      throw new InvalidConflictResolutionException(
        `Conflict '${input.conflictId}' was retracted by a metric-pack rescan and cannot be ` +
          `recorded as '${input.outcome}'`,
      );
    }

    const followedProposal =
      input.outcome === 'resolved' && input.proposedWinnerFactId !== undefined
        ? input.proposedWinnerFactId === input.winningFactId
        : undefined;

    conflict.resolution = {
      outcome: input.outcome,
      winningFactId: input.winningFactId ? new Types.ObjectId(input.winningFactId) : undefined,
      decidedBy: input.decidedBy,
      reason: input.reason,
      resolvedAt: new Date(),
      ruleFired: input.ruleFired,
      followedProposal,
    };

    if (input.outcome === 'resolved') {
      conflict.status = 'resolved';
    }

    if (input.outcome === 'timed_out') {
      // `ruleFired` is the fixed three-value `ConflictRuleFired` `requestResolution` captured
      // before the approval wait began — an operational fact (a human never came), not an error.
      approvalTimeoutCounter.add(1, { ruleFired: input.ruleFired ?? 'none' });
    }

    await conflict.save();

    this.logger.debug(
      `Recorded '${input.outcome}' resolution attempt for conflict '${input.conflictId}'`,
    );

    return { conflictId: input.conflictId, outcome: input.outcome };
  }

  /**
   * Pure given its inputs: looks up `metricId` in the tenant's resolved survivorship-policy map
   * (`policies`, built once per request by `MetricPoliciesService.resolveForTenant` — see `list`
   * and `requestResolution`, its only two callers) and calls `resolveConflictPolicy`. `metricId`
   * (from `Conflict.factKey.metric`, stored as a plain string on the schema) is not guaranteed to
   * be a metric the tenant's *currently* resolved active pack still defines — this conflict was
   * detected against whichever pack was active at scan time (stamped on `Conflict.packId`/
   * `packVersion`, see that field's own doc comment on staleness), while `policies` here is folded
   * over whatever pack is active right now; a pack activation between the two can drop the metric
   * entirely. `policies.get` therefore stays a checked lookup with a real miss branch: the `?? {
   * authorityOrder: undefined, stalenessWindowMs: Infinity }` fallback produces exactly the
   * `ruleFired: 'none'` a genuinely unconfigured metric already gets, rather than throw for a case
   * that isn't a data-integrity fault — this method only ever proposes, never gates.
   */
  private computeConflictProposal(
    candidates: readonly ConflictingFactForResolution[],
    metricId: string,
    policies: ReadonlyMap<string, SurvivorshipPolicy>,
  ): ResolveConflictProposal {
    const policy = policies.get(metricId) ?? {
      authorityOrder: undefined,
      stalenessWindowMs: Number.POSITIVE_INFINITY,
    };
    return resolveConflictPolicy(candidates, policy);
  }

  /**
   * `requestResolution`'s own proposal computation, run once at approval-request time (see that
   * method's doc comment for why the result then travels through the workflow rather than being
   * recomputed later) — loads this one conflict's current facts and reduces to
   * `computeConflictProposal`. Takes the minimal shape a proposal needs, not a full
   * `ConflictDocument`, so a caller that only has a `ConflictResolutionCandidate` in hand (as
   * `requestResolution` does) doesn't need a second full conflict read to supply this. A fact that
   * no longer resolves just narrows the candidate set `resolveConflictPolicy` sees, which already
   * degrades to `ruleFired: 'none'` on its own — this never throws, unlike `toConflictDto`'s
   * read-path integrity check. `policies` is the caller's already-resolved map, not re-resolved
   * here — `requestResolution` handles a single conflict, but the map still belongs to the request,
   * not to this one conflict.
   */
  private async computeProposalForConflict(
    conflict: { readonly factIds: readonly Types.ObjectId[]; readonly factKey: FactKey },
    tenantId: string,
    policies: ReadonlyMap<string, SurvivorshipPolicy>,
  ): Promise<ResolveConflictProposal> {
    const facts = await this.extractedFactModel.find({
      _id: { $in: conflict.factIds },
      tenantId,
    });
    const sourceClassByFactId = await loadSourceClassByFactId(
      this.documentVersionModel,
      this.documentModel,
      facts,
      tenantId,
    );
    // `loadSourceClassByFactId` sets an entry for every fact in the array it was given, and
    // `facts` is that exact array — the lookup below can never miss, so `as` (not `??`) keeps
    // TypeScript satisfied without an untestable fallback branch.
    const candidates: ConflictingFactForResolution[] = facts.map((fact) => ({
      id: fact._id.toString(),
      sourceClass: sourceClassByFactId.get(fact._id.toString()) as DocumentSourceClass,
      observedAt: fact.observedAt,
    }));
    return this.computeConflictProposal(candidates, conflict.factKey.metric, policies);
  }

  private toConflictDto(
    conflict: ConflictDocument,
    factById: Map<string, ExtractedFactDocument>,
    factEnrichmentByFactId: Map<string, FactSourceEnrichment>,
    policies: ReadonlyMap<string, SurvivorshipPolicy>,
    activePack: MetricPackData,
  ): ConflictResponseDto {
    const values: ConflictValueShape[] = [];
    const candidates: ConflictingFactForResolution[] = [];
    for (const id of conflict.factIds) {
      const fact = factById.get(id.toString());
      if (!fact) {
        continue;
      }
      // Same guarantee `computeProposalForConflict`'s identical lookup documents:
      // `factEnrichmentByFactId` is built (in `list`) from the same batch of facts `factById` was,
      // so a fact resolving above always has an entry here too. Withdrawal is display-only — this
      // never changes `status`, `factIds`, or which fact the survivorship policy proposes; see
      // `ResolutionBacktestService`'s own invariance test for why.
      const enrichment = factEnrichmentByFactId.get(fact._id.toString()) as FactSourceEnrichment;
      values.push({
        factId: fact._id.toString(),
        value: fact.value.amount,
        unit: fact.value.unit,
        sourceChunkId: fact.chunkId,
        documentVersionId: fact.documentVersionId.toString(),
        locator: fact.locator,
        withdrawn: enrichment.withdrawn,
      });
      candidates.push({
        id: fact._id.toString(),
        sourceClass: enrichment.sourceClass,
        observedAt: fact.observedAt,
      });
    }

    // A conflict's `packId`/`packVersion` are stamped at detection time (`detectAndPersist`) and
    // never rewritten in place — a pack activation between then and now (or a retraction that
    // hasn't reached this group yet) leaves the row stale: the pack that would run against this
    // group's facts today may no longer treat them as a disagreement at all. Independent of
    // `unscorable` below and computed for every row, including one — staleness and evidence
    // integrity are unrelated failure modes and a row can carry either, both, or neither.
    const stale =
      conflict.packId !== activePack.packId || conflict.packVersion !== activePack.version;

    const base = {
      id: conflict._id.toString(),
      // Spread rather than pass `conflict.factKey` through by reference: unlike
      // `ExtractedFact.factKey` (which uses an explicit `{ _id: false }` sub-schema), this path's
      // inline `{ type: {...} }` shorthand lets Mongoose mint an `_id` on the nested subdocument
      // — spreading the three declared fields keeps that stray id out of the response.
      factKey: {
        entity: conflict.factKey.entity,
        metric: conflict.factKey.metric,
        period: conflict.factKey.period,
      },
      factIds: conflict.factIds.map((id) => id.toString()),
      values,
      magnitude: conflict.magnitude,
      status: conflict.status,
      createdAt: conflict.createdAt,
      stale,
      staleReason: stale
        ? `Detected under pack '${conflict.packId}' v${conflict.packVersion}; the tenant's ` +
          `active pack is now '${activePack.packId}' v${activePack.version}.`
        : undefined,
    };

    if (values.length < conflict.factIds.length) {
      // FAILS OPEN: this is a display path, not a decision path — rendering a list must never 500
      // the whole page over one corrupted row. `DocumentsService.remove` keeps every conflict's
      // `factIds` in sync with the facts it deletes, but a row that arrived some other way (a
      // direct write, a bug elsewhere) is always possible, and the whole page must still render
      // around it. The row is still returned, marked `unscorable` — the same vocabulary
      // `ResolutionBacktestService.scoreConflict` already uses for this exact state — rather than
      // silently dropped, so a reviewer can see the conflict existed and that its evidence is
      // gone. Contrast `findConflictedFactGroupsForChunks` and `loadConflictForResolution` below:
      // both stay fail-CLOSED, because each backs a decision (grounding a live answer, proposing a
      // resolution winner) that must not proceed on an incomplete fact set.
      const missing = conflict.factIds.length - values.length;
      return {
        ...base,
        unscorable: true,
        unscorableReason: `${missing} of ${conflict.factIds.length} disagreeing fact(s) no longer resolve to an ExtractedFact.`,
      };
    }

    // Computed fresh on every read, never persisted: the tenant's resolved `authorityOrder` and a
    // document's `sourceClass` both change over time, so a stored proposal would silently go stale
    // and a reviewer could act on a rule that no longer applies.
    const proposal = this.computeConflictProposal(candidates, conflict.factKey.metric, policies);

    return {
      ...base,
      unscorable: false,
      proposedWinnerFactId:
        proposal.ruleFired === 'none' ? undefined : proposal.proposedWinnerFactId,
      ruleFired: proposal.ruleFired,
      explanation: proposal.explanation,
    };
  }
}
