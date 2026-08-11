import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { WorkflowRun } from '../../../../src/database/schemas/workflow/workflow-run/workflow-run.schema';
import { WorkflowRunNotFoundException } from '../../../../src/features/evidence/workflow-runs/exceptions/workflow-runs.exception';
import { WorkflowRunsService } from '../../../../src/features/evidence/workflow-runs/workflow-runs.service';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('WorkflowRunsService', () => {
  let service: WorkflowRunsService;

  const mockWorkflowRunModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn(), signal: jest.fn() };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowRunsService,
        { provide: getModelToken(WorkflowRun.name), useValue: mockWorkflowRunModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<WorkflowRunsService>(WorkflowRunsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('create', () => {
    it('should persist a WorkflowRun row and return its projection', async () => {
      const id = new Types.ObjectId();
      const createdAt = new Date('2026-07-01T00:00:00.000Z');
      mockWorkflowRunModel.create.mockResolvedValueOnce({
        _id: id,
        workflowId: 'wf-1',
        status: 'running',
        currentStep: undefined,
        errorMessage: undefined,
        createdAt,
      });

      const result = await service.create({
        workflowId: 'wf-1',
        status: 'running',
        tenantId: 'acme-corp',
      });

      expect(mockWorkflowRunModel.create).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        status: 'running',
        tenantId: 'acme-corp',
      });
      expect(result).toEqual({
        id: id.toString(),
        workflowId: 'wf-1',
        status: 'running',
        currentStep: undefined,
        errorMessage: undefined,
        createdAt,
      });
    });
  });

  describe('findById', () => {
    it('should throw WorkflowRunNotFoundException without querying when id is not a valid ObjectId', async () => {
      await expect(service.findById('not-an-id', 'actor')).rejects.toBeInstanceOf(
        WorkflowRunNotFoundException,
      );
      expect(mockWorkflowRunModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw WorkflowRunNotFoundException, tenant-scoped to the default tenant, when no run matches', async () => {
      const id = new Types.ObjectId().toString();
      mockWorkflowRunModel.findOne.mockResolvedValueOnce(null);

      await expect(service.findById(id, 'actor')).rejects.toBeInstanceOf(
        WorkflowRunNotFoundException,
      );
      expect(mockWorkflowRunModel.findOne).toHaveBeenCalledWith({
        _id: id,
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    it('should scope the lookup to an explicit tenantId when provided', async () => {
      const id = new Types.ObjectId().toString();
      mockWorkflowRunModel.findOne.mockResolvedValueOnce(null);

      await expect(service.findById(id, 'actor', 'acme-corp')).rejects.toBeInstanceOf(
        WorkflowRunNotFoundException,
      );
      expect(mockWorkflowRunModel.findOne).toHaveBeenCalledWith({
        _id: id,
        tenantId: 'acme-corp',
      });
    });

    it('should refresh the status from the live engine, record an audit event, and never write the row back', async () => {
      const id = new Types.ObjectId();
      const actorId = 'actor-1';
      const run = {
        _id: id,
        workflowId: 'wf-1',
        status: 'running',
        currentStep: 'awaiting_approval',
        errorMessage: undefined,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockWorkflowRunModel.findOne.mockResolvedValueOnce(run);
      mockWorkflowEngine.status.mockResolvedValueOnce({ id: 'wf-1', status: 'completed' });
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.findById(id.toString(), actorId);

      expect(mockWorkflowEngine.status).toHaveBeenCalledWith('wf-1');
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'workflow-runs.viewed',
        actorId,
        subject: { entityType: 'WorkflowRun', entityId: id.toString() },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result.status).toBe('completed');
      expect(mockWorkflowRunModel.findOne.mock.calls).toHaveLength(1);
    });

    it('should fail open to the durable status, logging a warning, when the engine call throws', async () => {
      const id = new Types.ObjectId();
      const run = {
        _id: id,
        workflowId: 'wf-1',
        status: 'running',
        currentStep: undefined,
        errorMessage: undefined,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockWorkflowRunModel.findOne.mockResolvedValueOnce(run);
      mockWorkflowEngine.status.mockRejectedValueOnce(new Error('temporal unreachable'));
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.findById(id.toString(), 'actor');

      expect(result.status).toBe('running');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining(id.toString()));
    });
  });
});
