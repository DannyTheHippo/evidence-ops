import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
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
    it('should page pending approvals for the default tenant and record an audit event scoped to the actor', async () => {
      const actorId = new Types.ObjectId().toString();
      const approval = buildApproval();
      mockApprovalModel.find.mockResolvedValueOnce([approval]);
      mockApprovalModel.countDocuments.mockResolvedValueOnce(1);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.listPending({ skip: 0, limit: 20 }, actorId);

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, state: 'pending' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(mockApprovalModel.countDocuments).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        state: 'pending',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'approvals.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: DEFAULT_TENANT_ID,
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
  });

  describe('decide', () => {
    const decideInput = {
      decision: 'approved' as const,
      reason: 'Evidence checks out.',
      actorId: new Types.ObjectId().toString(),
      decidedBy: 'reviewer@example.com',
    };

    it('should throw ApprovalNotFoundException without querying when id is not a valid ObjectId', async () => {
      await expect(service.decide('not-an-id', decideInput)).rejects.toBeInstanceOf(
        ApprovalNotFoundException,
      );
      expect(mockApprovalModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw ApprovalNotFoundException, tenant-scoped, when no approval matches', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOne.mockResolvedValueOnce(null);

      await expect(service.decide(id, decideInput)).rejects.toBeInstanceOf(
        ApprovalNotFoundException,
      );
      expect(mockApprovalModel.findOne).toHaveBeenCalledWith({
        _id: id,
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    it('should scope the lookup to an explicit tenantId when provided', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.decide(id, { ...decideInput, tenantId: 'acme-corp' }),
      ).rejects.toBeInstanceOf(ApprovalNotFoundException);
      expect(mockApprovalModel.findOne).toHaveBeenCalledWith({ _id: id, tenantId: 'acme-corp' });
    });

    it('should throw ApprovalAlreadyDecidedException when the approval is not pending', async () => {
      const id = new Types.ObjectId().toString();
      mockApprovalModel.findOne.mockResolvedValueOnce(buildApproval({ state: 'approved' }));

      await expect(service.decide(id, decideInput)).rejects.toBeInstanceOf(
        ApprovalAlreadyDecidedException,
      );
    });

    it('should persist the decision and return without signalling when the approval has no workflowId', async () => {
      const id = new Types.ObjectId().toString();
      const approval = buildApproval({ workflowId: undefined });
      mockApprovalModel.findOne.mockResolvedValueOnce(approval);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.decide(id, decideInput);

      expect(approval.save).toHaveBeenCalledTimes(1);
      expect(approval.state).toBe('approved');
      expect(approval.decidedBy).toBe('reviewer@example.com');
      expect(approval.decisionReason).toBe('Evidence checks out.');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining(id));
      expect(mockWorkflowEngine.signal).not.toHaveBeenCalled();
      expect(result.state).toBe('approved');
    });

    it('should persist the decision before signalling the workflow that requested it', async () => {
      const id = new Types.ObjectId().toString();
      const approval = buildApproval({ workflowId: 'wf-1' });
      mockApprovalModel.findOne.mockResolvedValueOnce(approval);
      mockAuditService.record.mockResolvedValueOnce(undefined);
      const callOrder: string[] = [];
      approval.save.mockImplementationOnce(() => {
        callOrder.push('save');
        return Promise.resolve();
      });
      mockWorkflowEngine.signal.mockImplementationOnce(() => {
        callOrder.push('signal');
        return Promise.resolve();
      });

      const result = await service.decide(id, decideInput);

      expect(callOrder).toEqual(['save', 'signal']);
      expect(mockWorkflowEngine.signal).toHaveBeenCalledWith('wf-1', 'approvalDecision', {
        claimedDecision: 'approved',
      });
      expect(result.state).toBe('approved');
    });

    it('should throw ApprovalSignalFailedException, with the decision already persisted, when signalling fails', async () => {
      const id = new Types.ObjectId().toString();
      const approval = buildApproval({ workflowId: 'wf-1' });
      mockApprovalModel.findOne.mockResolvedValueOnce(approval);
      mockAuditService.record.mockResolvedValueOnce(undefined);
      mockWorkflowEngine.signal.mockRejectedValueOnce(new Error('temporal unreachable'));

      await expect(service.decide(id, decideInput)).rejects.toBeInstanceOf(
        ApprovalSignalFailedException,
      );
      expect(approval.save).toHaveBeenCalledTimes(1);
      expect(approval.state).toBe('approved');
    });
  });
});
