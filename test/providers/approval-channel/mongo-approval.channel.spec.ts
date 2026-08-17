import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Approval } from '../../../src/database/schemas/workflow/approval/approval.schema';
import { MongoApprovalChannel } from '../../../src/providers/approval-channel/mongo-approval.channel';
import { getMockModel } from '../../utils/get-mock-model';

describe('MongoApprovalChannel', () => {
  let channel: MongoApprovalChannel;

  const mockApprovalModel = getMockModel();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MongoApprovalChannel,
        { provide: getModelToken(Approval.name), useValue: mockApprovalModel },
      ],
    }).compile();

    channel = module.get<MongoApprovalChannel>(MongoApprovalChannel);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('requestApproval', () => {
    it('should persist a pending row scoped to the given subject and tenant, and hand back its id', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.create.mockResolvedValueOnce({ _id: approvalId });
      const entityId = new Types.ObjectId().toString();

      const handle = await channel.requestApproval({
        action: 'publish_report',
        summary: 'Publish the Q1 evidence report',
        subject: { entityType: 'Conflict', entityId },
        requestedBy: 'analyst@example.com',
        tenantId: 'acme-corp',
        workflowId: 'wf-1',
      });

      expect(mockApprovalModel.create).toHaveBeenCalledWith({
        action: 'publish_report',
        summary: 'Publish the Q1 evidence report',
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId(entityId) },
        requestedBy: 'analyst@example.com',
        tenantId: 'acme-corp',
        state: 'pending',
        workflowId: 'wf-1',
      });
      expect(handle).toEqual({ id: approvalId.toString() });
    });
  });

  describe('getDecision', () => {
    it('should return approved when the row exists with state approved', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findOne.mockResolvedValueOnce({
        state: 'approved',
        decidedBy: 'reviewer@example.com',
        decisionReason: 'evidence checks out',
      });

      const result = await channel.getDecision(approvalId.toString(), 'acme-corp');

      expect(mockApprovalModel.findOne).toHaveBeenCalledWith({
        _id: approvalId.toString(),
        tenantId: 'acme-corp',
      });
      expect(result).toEqual({
        decision: 'approved',
        decidedBy: 'reviewer@example.com',
        reason: 'evidence checks out',
      });
    });

    it('should return rejected when the row exists with state rejected', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findOne.mockResolvedValueOnce({
        state: 'rejected',
        decidedBy: 'reviewer@example.com',
        decisionReason: 'insufficient evidence',
      });

      const result = await channel.getDecision(approvalId.toString(), 'acme-corp');

      expect(result).toEqual({
        decision: 'rejected',
        decidedBy: 'reviewer@example.com',
        reason: 'insufficient evidence',
      });
    });

    it('should return rejected when the row is still pending — a timeout denies, it does not wait', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findOne.mockResolvedValueOnce({ state: 'pending' });

      const result = await channel.getDecision(approvalId.toString(), 'acme-corp');

      expect(result).toEqual({
        decision: 'rejected',
        decidedBy: undefined,
        reason: 'approval is pending',
      });
    });

    it('should return rejected when no row exists for the given id', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findOne.mockResolvedValueOnce(null);

      const result = await channel.getDecision(approvalId.toString(), 'acme-corp');

      expect(result).toEqual({
        decision: 'rejected',
        reason: `no approval record found for '${approvalId.toString()}'`,
      });
    });

    it('should return rejected for a malformed/unexpected state value rather than trusting it', async () => {
      const approvalId = new Types.ObjectId();
      // A hand-edited row or a future writer bug — the schema's own `enum` cannot protect a read
      // path against data that bypassed it, so `getDecision` must not trust a truthy-looking
      // value it does not recognize.
      mockApprovalModel.findOne.mockResolvedValueOnce({ state: 'APPROVED' });

      const result = await channel.getDecision(approvalId.toString(), 'acme-corp');

      expect(result).toEqual({
        decision: 'rejected',
        decidedBy: undefined,
        reason: 'approval is APPROVED',
      });
    });

    it('should return rejected without querying the model when the id is not a valid ObjectId', async () => {
      const result = await channel.getDecision('not-an-object-id', 'acme-corp');

      expect(mockApprovalModel.findOne).not.toHaveBeenCalled();
      expect(result).toEqual({
        decision: 'rejected',
        reason: "unknown approval id 'not-an-object-id'",
      });
    });

    it('should return rejected — never the real decision — when the approval id exists but under a different tenant', async () => {
      // `findOne({ _id, tenantId })` never matches a row that exists under another tenant, so
      // this must collapse to the same "no approval record found" branch as an unknown id — the
      // fail-closed contract the class's own doc comment describes, exercised end to end rather
      // than only asserted as a query argument.
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findOne.mockResolvedValueOnce(null);

      const result = await channel.getDecision(approvalId.toString(), 'other-tenant');

      expect(mockApprovalModel.findOne).toHaveBeenCalledWith({
        _id: approvalId.toString(),
        tenantId: 'other-tenant',
      });
      expect(result).toEqual({
        decision: 'rejected',
        reason: `no approval record found for '${approvalId.toString()}'`,
      });
    });
  });
});
