import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  Conflict,
  ConflictDocument,
  type ConflictResolutionOutcome,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import type { ResolveConflictWorkflowInput } from '../../../workflows/types';
import { METRIC_ONTOLOGY } from '../facts/metric-ontology';
import {
  WorkflowRunsService,
  type WorkflowRunResult,
} from '../workflow-runs/workflow-runs.service';
import type { ConflictValueShape } from './dtos/response/conflict.response.dto';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';
import { detectConflicts, groupKey } from './detect-conflicts';
import {
  ConflictNotFoundException,
  InvalidConflictResolutionException,
} from './exceptions/conflicts.exception';

export interface ConflictScanResult {
  readonly conflictsCreated: number;
  /** Facts `detectConflicts` could not normalize (an unrecognized unit) and dropped from this
   * scan — also logged individually at `warn` (see `scanForConflicts`), but surfaced here too so a
   * caller (the `eval` harness, a future admin surface) can assert on or alert on the count without
   * scraping logs. Zero on every run where every fact's unit was recognized. */
  readonly skippedFactCount: number;
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
  readonly tenantId?: string;
}

export interface RecordConflictResolutionResult {
  readonly conflictId: string;
  readonly outcome: ConflictResolutionOutcome;
}

export interface RequestConflictResolutionInput {
  readonly conflictId: string;
  readonly winningFactId: string;
  readonly actorId: string;
  /** Threaded into `ResolveConflictWorkflowInput.requestedBy` and, eventually, `Approval.requestedBy`
   *  — an opaque string (an email), not the account id, matching those fields' own doc comments. */
  readonly requestedBy: string;
  readonly tenantId?: string;
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

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly workflowRunsService: WorkflowRunsService,

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
    pagination: PaginationRequestDto,
    actorId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<DocumentResultWithCount<ConflictResponseDto>> {
    const filter = { tenantId };

    const [conflicts, count] = await Promise.all([
      this.conflictModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.conflictModel.countDocuments(filter),
    ]);

    let factById = new Map<string, ExtractedFactDocument>();
    if (conflicts.length > 0) {
      const everyFactId = [
        ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
      ].map((id) => new Types.ObjectId(id));
      const facts = await this.extractedFactModel.find({ _id: { $in: everyFactId } });
      factById = new Map(facts.map((fact) => [fact._id.toString(), fact]));
    }

    await this.auditService.record({
      action: 'conflicts.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return {
      docs: conflicts.map((conflict) => this.toConflictDto(conflict, factById)),
      count,
    };
  }

  /**
   * Scans every `ExtractedFact` for one tenant, groups by `(entity, metric, period)`, and
   * persists a `Conflict` for each group whose normalized values disagree by more than the
   * metric's tolerance.
   *
   * Idempotent by factKey rather than by a run identifier: a group that already has an `open`
   * `Conflict` is skipped, so re-running the scan after new evidence arrives only creates
   * conflicts for keys that did not already have one — it never duplicates an existing one, and it
   * never re-opens or touches a conflict a reviewer already resolved or dismissed (those statuses
   * are read as "already handled", not as "needs a fresh Conflict record").
   */
  async scanForConflicts(tenantId: string = DEFAULT_TENANT_ID): Promise<ConflictScanResult> {
    const facts = await this.extractedFactModel.find({ tenantId });
    const { conflicts: candidates, skipped } = detectConflicts(
      facts.map((fact) => ({
        id: fact._id.toString(),
        factKey: fact.factKey,
        value: fact.value,
      })),
      METRIC_ONTOLOGY,
    );

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

    const openConflicts = await this.conflictModel.find({ tenantId, status: 'open' });
    const alreadyOpenKeys = new Set(openConflicts.map((conflict) => groupKey(conflict.factKey)));
    const newCandidates = candidates.filter(
      (candidate) => !alreadyOpenKeys.has(groupKey(candidate.factKey)),
    );

    if (newCandidates.length === 0) {
      this.logger.debug(`All detected conflicts for tenant '${tenantId}' are already open`);
      return { conflictsCreated: 0, skippedFactCount: skipped.length };
    }

    await this.conflictModel.insertMany(
      newCandidates.map((candidate) => ({
        factKey: candidate.factKey,
        factIds: candidate.factIds.map((id) => new Types.ObjectId(id)),
        magnitude: candidate.magnitude,
        status: 'open',
        tenantId,
      })),
    );

    this.logger.debug(`Created ${newCandidates.length} conflicts for tenant '${tenantId}'`);

    return { conflictsCreated: newCandidates.length, skippedFactCount: skipped.length };
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
    const conflictingFacts = await this.extractedFactModel.find({ _id: { $in: everyFactId } });
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
    tenantId: string = DEFAULT_TENANT_ID,
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

    const facts = await this.extractedFactModel.find({ _id: { $in: conflict.factIds } });
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
      winningFactId,
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
   * that can't be honored. `workflowEngine.start` never chooses the winner (see
   * `ResolveConflictWorkflowInput`'s own doc comment); it only starts the gate. The returned
   * `WorkflowRunResult` — from `WorkflowRunsService.create`, this collection's first writer — gives
   * the caller an id to poll `GET /workflow-runs/:id` with.
   */
  async requestResolution(input: RequestConflictResolutionInput): Promise<WorkflowRunResult> {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;

    await this.loadConflictForResolution(input.conflictId, input.winningFactId, tenantId);

    const handle = await this.workflowEngine.start(RESOLVE_CONFLICT_WORKFLOW_TYPE, {
      conflictId: input.conflictId,
      winningFactId: input.winningFactId,
      requestedBy: input.requestedBy,
      tenantId,
    } satisfies ResolveConflictWorkflowInput);

    const run = await this.workflowRunsService.create({
      workflowId: handle.id,
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
   */
  async recordResolution(
    input: RecordConflictResolutionInput,
  ): Promise<RecordConflictResolutionResult> {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    if (!Types.ObjectId.isValid(input.conflictId)) {
      throw new ConflictNotFoundException(`Conflict '${input.conflictId}' not found`);
    }

    const conflict = await this.conflictModel.findOne({ _id: input.conflictId, tenantId });
    if (!conflict) {
      throw new ConflictNotFoundException(`Conflict '${input.conflictId}' not found`);
    }

    conflict.resolution = {
      outcome: input.outcome,
      winningFactId: input.winningFactId ? new Types.ObjectId(input.winningFactId) : undefined,
      decidedBy: input.decidedBy,
      reason: input.reason,
      resolvedAt: new Date(),
    };

    if (input.outcome === 'resolved') {
      conflict.status = 'resolved';
    }

    await conflict.save();

    this.logger.debug(
      `Recorded '${input.outcome}' resolution attempt for conflict '${input.conflictId}'`,
    );

    return { conflictId: input.conflictId, outcome: input.outcome };
  }

  private toConflictDto(
    conflict: ConflictDocument,
    factById: Map<string, ExtractedFactDocument>,
  ): ConflictResponseDto {
    const values: ConflictValueShape[] = [];
    for (const id of conflict.factIds) {
      const fact = factById.get(id.toString());
      if (!fact) {
        continue;
      }
      values.push({
        factId: fact._id.toString(),
        value: fact.value.amount,
        unit: fact.value.unit,
        sourceChunkId: fact.chunkId,
        documentVersionId: fact.documentVersionId.toString(),
        locator: fact.locator,
      });
    }

    if (values.length < conflict.factIds.length) {
      // A `Conflict.factIds` reference that no longer resolves to an `ExtractedFact` is a
      // data-integrity fault, not a normal degradation path — same reasoning
      // `findConflictedFactGroupsForChunks` applies to its identical check, and the same shape of
      // throw: silently presenting fewer values than `factIds` would let a human choose a winner
      // without seeing the whole disagreement.
      throw new InternalServerErrorException(
        `Conflict '${conflict._id.toString()}' references ${conflict.factIds.length} fact(s), but only ${values.length} still resolve to an ExtractedFact`,
      );
    }

    return {
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
    };
  }
}
