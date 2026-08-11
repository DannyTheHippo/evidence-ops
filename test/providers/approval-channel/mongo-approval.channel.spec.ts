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

    it('should pass tenantId through as undefined when the caller omits it, letting the schema default apply', async () => {
      mockApprovalModel.create.mockResolvedValueOnce({ _id: new Types.ObjectId() });

      await channel.requestApproval({
        action: 'publish_report',
        summary: 'Publish the Q1 evidence report',
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId().toString() },
      });

      expect(mockApprovalModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: undefined }),
      );
    });
  });

  describe('getDecision', () => {
    it('should return approved when the row exists with state approved', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findById.mockResolvedValueOnce({
        state: 'approved',
        decidedBy: 'reviewer@example.com',
        decisionReason: 'evidence checks out',
      });

      const result = await channel.getDecision(approvalId.toString());

      expect(mockApprovalModel.findById).toHaveBeenCalledWith(approvalId.toString());
      expect(result).toEqual({
        decision: 'approved',
        decidedBy: 'reviewer@example.com',
        reason: 'evidence checks out',
      });
    });

    it('should return rejected when the row exists with state rejected', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findById.mockResolvedValueOnce({
        state: 'rejected',
        decidedBy: 'reviewer@example.com',
        decisionReason: 'insufficient evidence',
      });

      const result = await channel.getDecision(approvalId.toString());

      expect(result).toEqual({
        decision: 'rejected',
        decidedBy: 'reviewer@example.com',
        reason: 'insufficient evidence',
      });
    });

    it('should return rejected when the row is still pending — a timeout denies, it does not wait', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findById.mockResolvedValueOnce({ state: 'pending' });

      const result = await channel.getDecision(approvalId.toString());

      expect(result).toEqual({
        decision: 'rejected',
        decidedBy: undefined,
        reason: 'approval is pending',
      });
    });

    it('should return rejected when no row exists for the given id', async () => {
      const approvalId = new Types.ObjectId();
      mockApprovalModel.findById.mockResolvedValueOnce(null);

      const result = await channel.getDecision(approvalId.toString());

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
      mockApprovalModel.findById.mockResolvedValueOnce({ state: 'APPROVED' });

      const result = await channel.getDecision(approvalId.toString());

      expect(result).toEqual({
        decision: 'rejected',
        decidedBy: undefined,
        reason: 'approval is APPROVED',
      });
    });

    it('should return rejected without querying the model when the id is not a valid ObjectId', async () => {
      const result = await channel.getDecision('not-an-object-id');

      expect(mockApprovalModel.findById).not.toHaveBeenCalled();
      expect(result).toEqual({
        decision: 'rejected',
        reason: "unknown approval id 'not-an-object-id'",
      });
    });
  });
});
