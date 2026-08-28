import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Approval } from '../../../../src/database/schemas/workflow/approval/approval.schema';
import { ApprovalsService } from '../../../../src/features/evidence/approvals/approvals.service';
import {
  ApprovalAlreadyDecidedException,
  ApprovalNotFoundException,
  ApprovalSignalFailedException,
} from '../../../../src/features/evidence/approvals/exceptions/approvals.exception';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('ApprovalsService', () => {
  let service: ApprovalsService;

  const mockApprovalModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn(), signal: jest.fn() };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalsService,
        { provide: getModelToken(Approval.name), useValue: mockApprovalModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ApprovalsService>(ApprovalsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // Typed explicitly (not inferred from the literal) so the service's in-place mutations
  // (`approval.state = ...`, `approval.decidedBy = ...`) type-check below — same reasoning
  // `conflicts.service.spec.ts`'s `MockConflictDoc` documents for its own mock document type.
  interface MockApprovalDoc {
    _id: Types.ObjectId;
    subject: { entityType: string; entityId: Types.ObjectId };
    action: string;
    summary: string;
    requestedBy?: string;
    state: string;
    workflowId?: string;
    decidedBy?: string;
    decidedAt?: Date;
    decisionReason?: string;
    createdAt: Date;
    save: jest.Mock;
  }

  const buildApproval = (overrides: Partial<MockApprovalDoc> = {}): MockApprovalDoc => ({
    _id: new Types.ObjectId(),
    subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
    action: 'resolve_conflict',
    summary: 'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
    requestedBy: 'analyst@example.com',
    state: 'pending',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  describe('listPending', () => {
    it('should page pending approvals for a tenant and record an audit event scoped to the actor', async () => {
      const actorId = new Types.ObjectId().toString();
      const approval = buildApproval();
      mockApprovalModel.find.mockResolvedValueOnce([approval]);
      mockApprovalModel.countDocuments.mockResolvedValueOnce(1);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.listPending({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', state: 'pending' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(mockApprovalModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        state: 'pending',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'approvals.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual({
        docs: [
          {
            id: approval._id.toString(),
            subject: {
              entityType: 'Conflict',
              entityId: approval.subject.entityId.toString(),
            },
            action: 'resolve_conflict',
            summary: approval.summary,
            requestedBy: 'analyst@example.com',
            workflowId: undefined,
            state: 'pending',
            decidedBy: undefined,
            decidedAt: undefined,
            decisionReason: undefined,
            createdAt: approval.createdAt,
          },
        ],
        count: 1,
      });
    });

    it('should scope the query to an explicit tenantId when provided', async () => {
      const actorId = new Types.ObjectId().toString();
      mockApprovalModel.find.mockResolvedValueOnce([]);
      mockApprovalModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.listPending({ skip: 0, limit: 20 }, actorId, 'acme-corp');

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        { tenantId: 'acme-corp', state: 'pending' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(result).toEqual({ docs: [], count: 0 });
    });

    it('should narrow the filter to the given state instead of the pending default', async () => {
      const actorId = new Types.ObjectId().toString();
      mockApprovalModel.find.mockResolvedValueOnce([]);
      mockApprovalModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.listPending({ skip: 0, limit: 20, state: 'approved' }, actorId, 'acme-corp');

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        { tenantId: 'acme-corp', state: 'approved' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(mockApprovalModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'acme-corp',
        state: 'approved',
      });
    });
  });

  describe('peekPending', () => {
    it('should page pending approvals for a tenant without recording an audit event', async () => {
      const approval = buildApproval();
      mockApprovalModel.find.mockResolvedValueOnce([approval]);
      mockApprovalModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.peekPending({ skip: 0, limit: 20 }, 'tenant-a');

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', state: 'pending' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(result.docs).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should scope the query to an explicit tenantId when provided', async () => {
      mockApprovalModel.find.mockResolvedValueOnce([]);
      mockApprovalModel.countDocuments.mockResolvedValueOnce(0);

      await service.peekPending({ skip: 0, limit: 20 }, 'acme-corp');

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        { tenantId: 'acme-corp', state: 'pending' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
    });

    it('should narrow the filter to a single workflowId when given, scoping the pending inbox to one run', async () => {
      mockApprovalModel.find.mockResolvedValueOnce([]);
      mockApprovalModel.countDocuments.mockResolvedValueOnce(0);

      await service.peekPending({ skip: 0, limit: 20 }, 'tenant-a', 'wf-1');

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', state: 'pending', workflowId: 'wf-1' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
    });
  });

  describe('decide', () => {
    const decideInput = {
      decision: 'approved' as const,
      reason: 'Evidence checks out.',
      actorId: new Types.ObjectId().toString(),
      decidedBy: 'reviewer@example.com',
      tenantId: 'acme-corp',
    };

    it('should throw ApprovalNotFoundException without querying when id is not a valid ObjectId', async () => {
      await expect(service.decide('not-an-id', decideInput)).rejects.toBeInstanceOf(
        ApprovalNotFoundException,
      );
      expect(mockApprovalModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw ApprovalNotFoundException, scoped to the given tenantId, when no approval matches', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(null);
      mockApprovalModel.exists.mockResolvedValueOnce(null);

      await expect(service.decide(id, decideInput)).rejects.toBeInstanceOf(
        ApprovalNotFoundException,
      );
      expect(mockApprovalModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: id, tenantId: 'acme-corp', state: 'pending' },
        expect.objectContaining({ state: 'approved', decidedBy: 'reviewer@example.com' }),
        { returnDocument: 'after' },
      );
      expect(mockApprovalModel.exists).toHaveBeenCalledWith({ _id: id, tenantId: 'acme-corp' });
    });

    it('should return rejected — never the real decision — when the approval exists under a different tenant', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(null);
      mockApprovalModel.exists.mockResolvedValueOnce(null);

      await expect(
        service.decide(id, { ...decideInput, tenantId: 'other-tenant' }),
      ).rejects.toBeInstanceOf(ApprovalNotFoundException);
      expect(mockApprovalModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: id, tenantId: 'other-tenant', state: 'pending' },
        expect.anything(),
        { returnDocument: 'after' },
      );
    });

    it('should throw ApprovalAlreadyDecidedException when the approval is not pending', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(null);
      mockApprovalModel.exists.mockResolvedValueOnce({ _id: id });

      await expect(service.decide(id, decideInput)).rejects.toBeInstanceOf(
        ApprovalAlreadyDecidedException,
      );
    });

    // Regression: two concurrent `decide()` calls on the same row both used to read `pending`
    // then write, producing two writes and two audit rows. The atomic `state: 'pending'`-guarded
    // `findOneAndUpdate` makes only the first call's write match — a losing concurrent call now
    // observes exactly this `null` result and is rejected here, never treated as a second success.
    it('should throw ApprovalAlreadyDecidedException, not a second success, for the loser of two concurrent decisions', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(null);
      mockApprovalModel.exists.mockResolvedValueOnce({ _id: id });

      await expect(
        service.decide(id, { ...decideInput, decision: 'rejected' }),
      ).rejects.toBeInstanceOf(ApprovalAlreadyDecidedException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(mockWorkflowEngine.signal).not.toHaveBeenCalled();
    });

    it('should persist the decision and return without signalling when the approval has no workflowId', async () => {
      const id = new Types.ObjectId().toString();
      const decided = buildApproval({
        workflowId: undefined,
        state: 'approved',
        decidedBy: 'reviewer@example.com',
        decisionReason: 'Evidence checks out.',
      });
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(decided);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.decide(id, decideInput);

      expect(mockApprovalModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: id, tenantId: 'acme-corp', state: 'pending' },
        {
          state: 'approved',
          decidedBy: 'reviewer@example.com',
          // Recast rather than bare `expect.any(Date)` inside the object literal — its `any`-typed
          // return trips `no-unsafe-assignment`.
          decidedAt: expect.any(Date) as Date,
          decisionReason: 'Evidence checks out.',
        },
        { returnDocument: 'after' },
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining(id));
      expect(mockWorkflowEngine.signal).not.toHaveBeenCalled();
      expect(result.state).toBe('approved');
    });

    it('should signal the workflow that requested it after the decision is durably persisted', async () => {
      const id = new Types.ObjectId().toString();
      const decided = buildApproval({
        workflowId: 'wf-1',
        state: 'approved',
        decidedBy: 'reviewer@example.com',
      });
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(decided);
      mockAuditService.record.mockResolvedValueOnce(undefined);
      mockWorkflowEngine.signal.mockResolvedValueOnce(undefined);

      const result = await service.decide(id, decideInput);

      expect(mockWorkflowEngine.signal).toHaveBeenCalledWith('wf-1', 'approvalDecision', {
        claimedDecision: 'approved',
      });
      expect(result.state).toBe('approved');
    });

    it('should throw ApprovalSignalFailedException, with the decision already persisted, when signalling fails', async () => {
      const id = new Types.ObjectId().toString();
      const decided = buildApproval({ workflowId: 'wf-1', state: 'approved' });
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(decided);
      mockAuditService.record.mockResolvedValueOnce(undefined);
      mockWorkflowEngine.signal.mockRejectedValueOnce(new Error('temporal unreachable'));

      await expect(service.decide(id, decideInput)).rejects.toBeInstanceOf(
        ApprovalSignalFailedException,
      );
    });
  });

  describe('expire', () => {
    it('should no-op without querying when id is not a valid ObjectId', async () => {
      await service.expire('not-an-id', 'acme-corp');

      expect(mockApprovalModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    // Regression: this is the fix for the durable `Approval` row disagreeing with the workflow
    // that owns it — a still-`pending` row left behind by a timed-out `resolveConflict` execution
    // must move to `timed_out` so it leaves the pending inbox and can never be decided afterwards.
    it("should move a pending approval to 'timed_out', scoped to id and tenant", async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(
        buildApproval({ _id: new Types.ObjectId(id), state: 'timed_out' }),
      );

      await service.expire(id, 'acme-corp');

      expect(mockApprovalModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: id, tenantId: 'acme-corp', state: 'pending' },
        { state: 'timed_out' },
      );
    });

    // FAILS CLOSED the other direction too: a decision that already moved the row off `pending`
    // must win over a late timeout — `findOneAndUpdate`'s own `state: 'pending'` filter makes that
    // case a no-op rather than an overwrite, and this asserts the call still happens (so a real
    // timeout for a still-pending row is never skipped) without asserting on its return value.
    it('should no-op, not throw, when the row already left pending', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(service.expire(id, 'acme-corp')).resolves.toBeUndefined();
    });
  });
});
