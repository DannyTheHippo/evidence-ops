import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Approval,
  type ApprovalDocument,
} from '../../../database/schemas/workflow/approval/approval.schema';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import type { ApprovalDecisionSignal } from '../../../workflows/types';
import {
  DEFAULT_APPROVAL_SORT_DIRECTION,
  DEFAULT_APPROVAL_SORT_FIELD,
  type ListApprovalsRequestDto,
} from './dtos/request/list-approvals.request.dto';
import type { ApprovalResponseDto } from './dtos/response/approval.response.dto';
import {
  ApprovalAlreadyDecidedException,
  ApprovalNotFoundException,
  ApprovalSignalFailedException,
} from './exceptions/approvals.exception';

export type ApprovalDecisionInput = 'approved' | 'rejected';

export interface DecideApprovalInput {
  readonly decision: ApprovalDecisionInput;
  readonly reason?: string;
  /** Audit actor — the account id, distinct from `decidedBy` below (Nest's `AuthenticatedRequest`
   *  carries both; audit rows always key on id, `Approval.decidedBy` is an opaque string per its
   *  schema's own doc comment). */
  readonly actorId: string;
  readonly decidedBy: string;
  readonly tenantId: string;
}

/**
 * `'approvalDecision'` — the signal name every workflow with an approval gate registers via
 * `defineSignal` (`resolve-conflict.workflow.ts`'s `approvalDecisionSignal`,
 * `ingest-document-version.workflow.ts`'s `ingestApprovalDecisionSignal`) — is not exported as a
 * runtime value from `src/workflows/**` (that directory only exports argument/return types across
 * the determinism fence; see its `types.ts` top-of-file comment). Duplicated here rather than
 * imported, the same reasoning `qa.service.ts`'s `ANSWER_QUESTION_WORKFLOW_TYPE` and
 * `documents.service.ts`'s `INGEST_DOCUMENT_VERSION_WORKFLOW_TYPE` already document for workflow
 * type names. One constant signals either kind of gated workflow identically: `decide()` below
 * only ever looks at `approval.workflowId`, never at which workflow type created the row.
 */
const APPROVAL_DECISION_SIGNAL = 'approvalDecision';

@Injectable()
export class ApprovalsService {
  constructor(
    @InjectModel(Approval.name)
    private readonly approvalModel: Model<ApprovalDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ApprovalsService.name);
  }

  /** The pending inbox: every `Approval` still awaiting a human decision, tenant-scoped —
   * `dto.state` narrows to a different state instead when given, but defaults to `pending`.
   * `dto.workflowId` narrows it further to one workflow's own request, matching `peekPending`'s
   * optional third argument. */
  async listPending(
    dto: ListApprovalsRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<ApprovalResponseDto>> {
    const result = await this.peekPending(dto, tenantId, dto.workflowId);

    await this.auditService.record({
      action: 'approvals.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return result;
  }

  /**
   * The audit-free half of `listPending` — reused by `WorkflowRunsService.streamRun`'s approvals
   * sub-stream, which ticks every 1.5s for the life of an open connection. `listPending` delegates
   * here so the two paths cannot drift; only it, and `streamRun`'s own deduped opening record, ever
   * write the `approvals.listed`/`workflow-runs.viewed` audit rows.
   *
   * `workflowId`, when given, narrows the pending inbox to approvals requested by that one
   * workflow — `streamRun` passes its run's own `workflowId` so a caller who names one run id sees
   * only that run's approval, not the tenant's whole inbox. Omitted (the `GET /approvals` path,
   * via `listPending`) returns the full tenant-scoped inbox as before.
   */
  async peekPending(
    dto: ListApprovalsRequestDto,
    tenantId: string,
    workflowId?: string,
  ): Promise<DocumentResultWithCount<ApprovalResponseDto>> {
    const filter = {
      tenantId,
      state: dto.state ?? 'pending',
      ...(workflowId ? { workflowId } : {}),
    };

    const [approvals, count] = await Promise.all([
      this.approvalModel.find(filter, null, {
        sort: resolveSort(
          dto.sort,
          dto.sortDir,
          DEFAULT_APPROVAL_SORT_FIELD,
          DEFAULT_APPROVAL_SORT_DIRECTION,
        ),
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.approvalModel.countDocuments(filter),
    ]);

    return { docs: approvals.map((approval) => this.toApprovalDto(approval)), count };
  }

  /**
   * Records a human's decision and wakes the workflow that requested it — the two halves of a
   * single permission boundary, in a specific order that matters (D3 of the approvals milestone).
   *
   * PERSIST BEFORE SIGNAL. `resolveConflict` (`resolve-conflict.workflow.ts`) never trusts the
   * signal payload itself — on waking, it re-reads this row via `getApprovalDecision`
   * (`MongoApprovalChannel.getDecision`), which is the only authority. Signalling before the write
   * lands would open a window where the workflow wakes and finds the row still `pending`, which
   * `getDecision` fails closed to `rejected` — an unrecoverable false rejection for a run that was,
   * in fact, approved. Writing first closes that window: by the time anything can wake the
   * workflow, the row it will read already holds the real decision.
   */
  async decide(id: string, input: DecideApprovalInput): Promise<ApprovalResponseDto> {
    const tenantId = input.tenantId;
    if (!Types.ObjectId.isValid(id)) {
      throw new ApprovalNotFoundException(`Approval '${id}' not found`);
    }

    // Atomic read-and-write, not `findOne` then `.save()`: the prior read-then-write let two
    // concurrent decisions both read `pending` and both write, producing two audit rows and
    // signalling the workflow twice for a permission boundary that must only ever fire once. The
    // `state: 'pending'` filter makes this the single write that can win — a second concurrent
    // call's `findOneAndUpdate` matches nothing and comes back `null`. FAILS CLOSED: `null` is
    // never treated as success.
    //
    // Tenant-scoped: D1 left `getDecision` unscoped because its only caller (workflow code) held
    // an id it had just minted — that trust does not extend here, where the id comes from an
    // external HTTP caller who could otherwise guess another tenant's approval id.
    const approval = await this.approvalModel.findOneAndUpdate(
      { _id: id, tenantId, state: 'pending' },
      {
        state: input.decision,
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
        decisionReason: input.reason,
      },
      { returnDocument: 'after' },
    );

    if (!approval) {
      // `null` means either no such approval exists under this tenant, or one does but already
      // left `pending` (the race this method now closes) — distinguished by a second, cheap read
      // so the two keep their existing, distinct HTTP statuses rather than collapsing into one.
      const exists = await this.approvalModel.exists({ _id: id, tenantId });
      if (!exists) {
        throw new ApprovalNotFoundException(`Approval '${id}' not found`);
      }
      throw new ApprovalAlreadyDecidedException(
        `Approval '${id}' is already decided — a decision cannot be re-applied`,
      );
    }

    await this.auditService.record({
      action: 'approvals.decided',
      actorId: input.actorId,
      subject: { entityType: 'Approval', entityId: id },
      tenantId,
    });

    if (!approval.workflowId) {
      // No workflow to wake. Every in-repo requester (`resolveConflict`, D2;
      // `ingestDocumentVersion`, D5) always sets `workflowId` via `workflowInfo().workflowId`, so
      // this only fires for a pre-D3 row minted before `workflowId` was threaded through, or a
      // future caller of `ApprovalChannel.requestApproval` that isn't itself a workflow. The
      // decision is still durably recorded above; there is simply nothing left to do.
      this.logger.warn(
        `Approval '${id}' has no workflowId — decision persisted with nothing to wake`,
      );
      return this.toApprovalDto(approval);
    }

    try {
      await this.workflowEngine.signal(approval.workflowId, APPROVAL_DECISION_SIGNAL, {
        claimedDecision: input.decision,
      } satisfies ApprovalDecisionSignal);
    } catch (error) {
      // FAIL CLOSED: this is the permission-boundary half of `decide()`, not a measurement — a
      // swallowed failure here would leave a live `resolveConflict` execution asleep until its 24h
      // `condition()` timeout, which records `timed_out` despite a real decision already sitting on
      // this row. The decision itself is safely durable (persisted above); what failed is only the
      // wake-up, and that failure must be visible, not silently dropped.
      throw new ApprovalSignalFailedException(
        `Decision for approval '${id}' was persisted, but signalling workflow '${approval.workflowId}' failed`,
        error,
      );
    }

    return this.toApprovalDto(approval);
  }

  /**
   * Called from the `expireApproval` activity (`src/worker/activities.ts`), itself called from
   * `resolveConflict`'s timeout branch (`resolve-conflict.workflow.ts`) once its 24-hour
   * `condition()` wait elapses with no signal. Moves a still-`pending` row to `timed_out` so it
   * leaves the pending inbox and can never be decided afterwards — restoring the property that the
   * durable row and the workflow that owned it can never disagree about whether a human authorised
   * something.
   *
   * Same atomic, `state: 'pending'`-guarded write `decide()` uses, and FAILS CLOSED the same way:
   * if a human decision already landed and moved the row off `pending` before this runs, the
   * filter matches nothing and this is a no-op — a real decision that beat the timeout to the row
   * always wins, and a late timeout must never overwrite it. No exception on a no-op: an activity
   * retry after a crash between "update succeeded" and "activity reported complete" would
   * otherwise fail a call that already did its job.
   */
  async expire(id: string, tenantId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      return;
    }
    await this.approvalModel.findOneAndUpdate(
      { _id: id, tenantId, state: 'pending' },
      { state: 'timed_out' },
    );
  }

  private toApprovalDto(approval: ApprovalDocument): ApprovalResponseDto {
    return {
      id: approval._id.toString(),
      subject: {
        entityType: approval.subject.entityType,
        entityId: approval.subject.entityId.toString(),
      },
      action: approval.action,
      summary: approval.summary,
      requestedBy: approval.requestedBy,
      workflowId: approval.workflowId,
      state: approval.state,
      decidedBy: approval.decidedBy,
      decidedAt: approval.decidedAt,
      decisionReason: approval.decisionReason,
      createdAt: approval.createdAt,
    };
  }
}
