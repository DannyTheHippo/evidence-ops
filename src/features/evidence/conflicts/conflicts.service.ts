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
import { findMetricById, METRIC_ONTOLOGY } from '../facts/metric-ontology';
import {
  WorkflowRunsService,
  type WorkflowRunResult,
} from '../workflow-runs/workflow-runs.service';
import type { ListConflictsRequestDto } from './dtos/request/list-conflicts.request.dto';
import type { ConflictValueShape } from './dtos/response/conflict.response.dto';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';
import { detectConflicts, groupKey, type FactForConflictScan } from './detect-conflicts';
import {
  ConflictNotFoundException,
  ConflictResolutionAlreadyPendingException,
  InvalidConflictResolutionException,
} from './exceptions/conflicts.exception';
import {
  resolveConflictPolicy,
  type ConflictingFactForResolution,
  type ResolveConflictProposal,
} from './resolve-conflict-policy';

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
    let sourceClassByFactId = new Map<string, DocumentSourceClass>();
    if (conflicts.length > 0) {
      const everyFactId = [
        ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
      ].map((id) => new Types.ObjectId(id));
      const facts = await this.extractedFactModel.find({ _id: { $in: everyFactId }, tenantId });
      factById = new Map(facts.map((fact) => [fact._id.toString(), fact]));
      sourceClassByFactId = await this.loadSourceClassByFactId(facts, tenantId);
    }

    await this.auditService.record({
      action: 'conflicts.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return {
      docs: conflicts.map((conflict) =>
        this.toConflictDto(conflict, factById, sourceClassByFactId),
      ),
      count,
    };
  }

  /**
   * Scans `ExtractedFact`s for one tenant, groups by `(entity, metric, period)`, and persists a
   * `Conflict` for each group whose normalized values disagree by more than the metric's
   * tolerance.
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
   * Idempotent by factKey rather than by a run identifier: a group that already has an `open`
   * `Conflict` is skipped, so re-running either path after new evidence arrives only creates
   * conflicts for keys that did not already have one — it never duplicates an existing one, and it
   * never re-opens or touches a conflict a reviewer already resolved or dismissed (those statuses
   * are read as "already handled", not as "needs a fresh Conflict record").
   */
  async scanForConflicts(
    tenantId: string,
    factKeys?: readonly FactKey[],
  ): Promise<ConflictScanResult> {
    if (factKeys !== undefined) {
      const groupKeys = [...new Set(factKeys.map(groupKey))];
      const facts = await this.extractedFactModel.find(
        { tenantId, groupKeyNormalized: { $in: groupKeys } },
        { factKey: 1, value: 1 },
      );
      return this.detectAndPersist(
        tenantId,
        facts.map((fact) => this.toFactForScan(fact)),
        {
          tenantId,
          status: 'open',
          groupKeyNormalized: { $in: groupKeys },
        },
      );
    }

    const facts: FactForConflictScan[] = [];
    const cursor = this.extractedFactModel.find({ tenantId }, { factKey: 1, value: 1 }).cursor();
    for await (const fact of cursor) {
      facts.push(this.toFactForScan(fact));
    }
    return this.detectAndPersist(tenantId, facts, { tenantId, status: 'open' });
  }

  private toFactForScan(fact: {
    _id: Types.ObjectId;
    factKey: FactKey;
    value: FactValue;
  }): FactForConflictScan {
    return { id: fact._id.toString(), factKey: fact.factKey, value: fact.value };
  }

  private async detectAndPersist(
    tenantId: string,
    facts: readonly FactForConflictScan[],
    openConflictFilter: QueryFilter<ConflictDocument>,
  ): Promise<ConflictScanResult> {
    const { conflicts: candidates, skipped } = detectConflicts(facts, METRIC_ONTOLOGY);

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

    const openConflicts = await this.conflictModel.find(openConflictFilter);
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
        groupKeyNormalized: groupKey(candidate.factKey),
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
   * comment for why it never recomputes them itself).
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

    const proposal = await this.computeProposalForConflict(
      {
        factIds: candidate.values.map((value) => new Types.ObjectId(value.factId)),
        factKey: candidate.factKey,
      },
      tenantId,
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
   * Batch-resolves each fact's document `sourceClass` via its `documentVersionId` — two `$in`
   * queries total (`DocumentVersion` then `Document`), never one per fact, so a page of conflicts
   * costs the same two extra round-trips regardless of how many facts it touches. Every query is
   * scoped to `tenantId` explicitly, not left to `tenantScopePlugin`'s ALS backstop alone: the
   * plugin is a backstop by its own doc comment, not the primary control, and this method's
   * result flows into a response payload — the same reasoning `list`'s own explicit-tenantId
   * queries apply to theirs.
   *
   * Fails OPEN to `'unclassified'` when a fact's `documentVersionId` or that version's `documentId`
   * no longer resolves — this is enrichment for a proposal a human still has to approve, not the
   * factIds/values integrity check `toConflictDto` applies to its own data; a fact's document
   * missing is exactly what `'unclassified'` already means (`Document.sourceClass`'s own doc
   * comment: "no authority information"), not a data-integrity fault worth aborting the read for.
   */
  private async loadSourceClassByFactId(
    facts: readonly Pick<ExtractedFactDocument, '_id' | 'documentVersionId'>[],
    tenantId: string,
  ): Promise<Map<string, DocumentSourceClass>> {
    if (facts.length === 0) {
      return new Map();
    }

    const versionIds = [...new Set(facts.map((fact) => fact.documentVersionId.toString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const versions = await this.documentVersionModel.find(
      { _id: { $in: versionIds }, tenantId },
      { documentId: 1 },
    );
    const documentIdByVersionId = new Map(
      versions.map((version) => [version._id.toString(), version.documentId.toString()]),
    );

    const documentIds = [...new Set(versions.map((version) => version.documentId.toString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const documents =
      documentIds.length === 0
        ? []
        : await this.documentModel.find(
            { _id: { $in: documentIds }, tenantId },
            { sourceClass: 1 },
          );
    const sourceClassByDocumentId = new Map(
      documents.map((document) => [document._id.toString(), document.sourceClass]),
    );

    const sourceClassByFactId = new Map<string, DocumentSourceClass>();
    for (const fact of facts) {
      const documentId = documentIdByVersionId.get(fact.documentVersionId.toString());
      const sourceClass = documentId ? sourceClassByDocumentId.get(documentId) : undefined;
      sourceClassByFactId.set(fact._id.toString(), sourceClass ?? 'unclassified');
    }
    return sourceClassByFactId;
  }

  /**
   * Pure given its inputs: looks up `metricId` in `METRIC_ONTOLOGY` and calls
   * `resolveConflictPolicy`. `stalenessWindowMs` defaults to `Infinity` when the metric leaves it
   * unconfigured — matching `MetricDefinition.stalenessWindowMs`'s own doc comment ("a metric whose
   * value ... does not drift"): with no window, no `observedAt` gap between authority-tied facts
   * can ever exceed it, so recency never breaks a tie the metric's own ontology entry says recency
   * should not be deciding.
   */
  private computeConflictProposal(
    candidates: readonly ConflictingFactForResolution[],
    metricId: string,
  ): ResolveConflictProposal {
    const metric = findMetricById(METRIC_ONTOLOGY, metricId);
    return resolveConflictPolicy(candidates, {
      authorityOrder: metric?.authorityOrder,
      stalenessWindowMs: metric?.stalenessWindowMs ?? Number.POSITIVE_INFINITY,
    });
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
   * read-path integrity check.
   */
  private async computeProposalForConflict(
    conflict: { readonly factIds: readonly Types.ObjectId[]; readonly factKey: FactKey },
    tenantId: string,
  ): Promise<ResolveConflictProposal> {
    const facts = await this.extractedFactModel.find({
      _id: { $in: conflict.factIds },
      tenantId,
    });
    const sourceClassByFactId = await this.loadSourceClassByFactId(facts, tenantId);
    // `loadSourceClassByFactId` sets an entry for every fact in the array it was given, and
    // `facts` is that exact array — the lookup below can never miss, so `as` (not `??`) keeps
    // TypeScript satisfied without an untestable fallback branch.
    const candidates: ConflictingFactForResolution[] = facts.map((fact) => ({
      id: fact._id.toString(),
      sourceClass: sourceClassByFactId.get(fact._id.toString()) as DocumentSourceClass,
      observedAt: fact.observedAt,
    }));
    return this.computeConflictProposal(candidates, conflict.factKey.metric);
  }

  private toConflictDto(
    conflict: ConflictDocument,
    factById: Map<string, ExtractedFactDocument>,
    sourceClassByFactId: Map<string, DocumentSourceClass>,
  ): ConflictResponseDto {
    const values: ConflictValueShape[] = [];
    const candidates: ConflictingFactForResolution[] = [];
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
      // Same guarantee as `computeProposalForConflict`'s identical lookup: `sourceClassByFactId`
      // is built (in `list`) from the same batch of facts `factById` was, so a fact resolving
      // above always has an entry here too.
      candidates.push({
        id: fact._id.toString(),
        sourceClass: sourceClassByFactId.get(fact._id.toString()) as DocumentSourceClass,
        observedAt: fact.observedAt,
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

    // Computed fresh on every read, never persisted: the ontology's `authorityOrder` and a
    // document's `sourceClass` both change over time, so a stored proposal would silently go stale
    // and a reviewer could act on a rule that no longer applies.
    const proposal = this.computeConflictProposal(candidates, conflict.factKey.metric);

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
      proposedWinnerFactId:
        proposal.ruleFired === 'none' ? undefined : proposal.proposedWinnerFactId,
      ruleFired: proposal.ruleFired,
      explanation: proposal.explanation,
    };
  }
}
