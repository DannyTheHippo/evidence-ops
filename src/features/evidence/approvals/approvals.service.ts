import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  Approval,
  type ApprovalDocument,
} from '../../../database/schemas/workflow/approval/approval.schema';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import type { ApprovalDecisionSignal } from '../../../workflows/types';
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
  readonly tenantId?: string;
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

  /** The pending inbox: every `Approval` still awaiting a human decision, tenant-scoped. */
  async listPending(
    pagination: PaginationRequestDto,
    actorId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<DocumentResultWithCount<ApprovalResponseDto>> {
    const filter = { tenantId, state: 'pending' as const };

    const [approvals, count] = await Promise.all([
      this.approvalModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.approvalModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'approvals.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

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
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    if (!Types.ObjectId.isValid(id)) {
      throw new ApprovalNotFoundException(`Approval '${id}' not found`);
    }

    // Tenant-scoped: D1 left `getDecision` unscoped because its only caller (workflow code) held
    // an id it had just minted — that trust does not extend here, where the id comes from an
    // external HTTP caller who could otherwise guess another tenant's approval id.
    const approval = await this.approvalModel.findOne({ _id: id, tenantId });
    if (!approval) {
      throw new ApprovalNotFoundException(`Approval '${id}' not found`);
    }

    if (approval.state !== 'pending') {
      throw new ApprovalAlreadyDecidedException(
        `Approval '${id}' is already '${approval.state}' — a decision cannot be re-applied`,
      );
    }

    approval.state = input.decision;
    approval.decidedBy = input.decidedBy;
    approval.decidedAt = new Date();
    approval.decisionReason = input.reason;
    await approval.save();

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
