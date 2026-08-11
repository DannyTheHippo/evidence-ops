import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Approval,
  type ApprovalDocument,
} from '../../database/schemas/workflow/approval/approval.schema';
import type {
  ApprovalChannel,
  ApprovalHandle,
  ApprovalRequest,
  ApprovalResult,
} from './approval-channel.interface';

/**
 * Real `ApprovalChannel` binding (D1 of the approvals milestone — see the interface's doc
 * comment for why the contract is split into `requestApproval`/`getDecision` rather than one
 * blocking call). This class only persists and reads back; it never waits.
 */
@Injectable()
export class MongoApprovalChannel implements ApprovalChannel {
  constructor(
    @InjectModel(Approval.name) private readonly approvalModel: Model<ApprovalDocument>,
  ) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalHandle> {
    // `request.context` is not persisted: no query pattern needs it yet, and this collection has
    // no free-form field to hold it. Add one when a real caller needs it read back.
    const approval = await this.approvalModel.create({
      action: request.action,
      summary: request.summary,
      subject: {
        entityType: request.subject.entityType,
        entityId: new Types.ObjectId(request.subject.entityId),
      },
      requestedBy: request.requestedBy,
      // Undefined here lets the schema's own `default: DEFAULT_TENANT_ID` apply, matching every
      // other write path — never assume a tenant here (9f0c2f2 was exactly this failure mode).
      tenantId: request.tenantId,
      state: 'pending',
    });

    return { id: approval._id.toString() };
  }

  /**
   * FAIL CLOSED — this is a permission gate, not a measurement gate, so an unresolved or
   * unrecognized state must never read as approval. `approval.state !== 'approved'` on purpose,
   * never a truthiness check: a malformed or unexpected state string must not accidentally pass.
   * A caller waking from a 24-hour `condition()` timeout (ADR-0003) rather than a decision signal
   * finds the row still `pending` here, which this collapses to `rejected` — a timeout denies,
   * it does not leave the caller hanging.
   */
  async getDecision(approvalId: string): Promise<ApprovalResult> {
    if (!Types.ObjectId.isValid(approvalId)) {
      return { decision: 'rejected', reason: `unknown approval id '${approvalId}'` };
    }

    const approval = await this.approvalModel.findById(approvalId);
    if (!approval) {
      return { decision: 'rejected', reason: `no approval record found for '${approvalId}'` };
    }

    if (approval.state !== 'approved') {
      return {
        decision: 'rejected',
        decidedBy: approval.decidedBy,
        reason: approval.decisionReason ?? `approval is ${approval.state}`,
      };
    }

    return {
      decision: 'approved',
      decidedBy: approval.decidedBy,
      reason: approval.decisionReason,
    };
  }
}
