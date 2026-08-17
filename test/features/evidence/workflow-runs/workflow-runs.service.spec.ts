import type { MessageEvent } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { WorkflowRun } from '../../../../src/database/schemas/workflow/workflow-run/workflow-run.schema';
import { ApprovalsService } from '../../../../src/features/evidence/approvals/approvals.service';
import { WorkflowRunNotFoundException } from '../../../../src/features/evidence/workflow-runs/exceptions/workflow-runs.exception';
import { WORKFLOW_RUN_STREAM_INTERVAL_MS } from '../../../../src/features/evidence/workflow-runs/workflow-runs.constant';
import { WorkflowRunsService } from '../../../../src/features/evidence/workflow-runs/workflow-runs.service';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
} from '../../../../src/shared/constants/sse.constant';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('WorkflowRunsService', () => {
  let service: WorkflowRunsService;

  const mockWorkflowRunModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn(), signal: jest.fn() };
  const mockApprovalsService = { listPending: jest.fn(), peekPending: jest.fn() };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowRunsService,
        { provide: getModelToken(WorkflowRun.name), useValue: mockWorkflowRunModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: ApprovalsService, useValue: mockApprovalsService },
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
      await expect(service.findById('not-an-id', 'actor', 'tenant-a')).rejects.toBeInstanceOf(
        WorkflowRunNotFoundException,
      );
      expect(mockWorkflowRunModel.findOne).not.toHaveBeenCalled();
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

      const result = await service.findById(id.toString(), actorId, 'tenant-a');

      expect(mockWorkflowEngine.status).toHaveBeenCalledWith('wf-1');
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'workflow-runs.viewed',
        actorId,
        subject: { entityType: 'WorkflowRun', entityId: id.toString() },
        tenantId: 'tenant-a',
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

      const result = await service.findById(id.toString(), 'actor', 'tenant-a');

      expect(result.status).toBe('running');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining(id.toString()));
    });
  });

  describe('listByWorkflowId', () => {
    it('should page runs by workflowId, never refreshing from the live engine, and record an audit event scoped to the actor', async () => {
      const actorId = new Types.ObjectId().toString();
      const id = new Types.ObjectId();
      const run = {
        _id: id,
        workflowId: 'wf-1',
        status: 'running',
        currentStep: undefined,
        errorMessage: undefined,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockWorkflowRunModel.find.mockResolvedValueOnce([run]);
      mockWorkflowRunModel.countDocuments.mockResolvedValueOnce(1);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.listByWorkflowId(
        { workflowId: 'wf-1', skip: 0, limit: 20 },
        actorId,
        'tenant-a',
      );

      expect(mockWorkflowRunModel.find).toHaveBeenCalledWith(
        { workflowId: 'wf-1', tenantId: 'tenant-a' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(mockWorkflowRunModel.countDocuments).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'workflow-runs.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
      });
      expect(mockWorkflowEngine.status).not.toHaveBeenCalled();
      expect(result).toEqual({
        docs: [
          {
            id: id.toString(),
            workflowId: 'wf-1',
            status: 'running',
            currentStep: undefined,
            errorMessage: undefined,
            createdAt: run.createdAt,
          },
        ],
        count: 1,
      });
    });

    it('should scope the lookup to an explicit tenantId when provided', async () => {
      const actorId = new Types.ObjectId().toString();
      mockWorkflowRunModel.find.mockResolvedValueOnce([]);
      mockWorkflowRunModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.listByWorkflowId(
        { workflowId: 'wf-1', skip: 0, limit: 20 },
        actorId,
        'acme-corp',
      );

      expect(mockWorkflowRunModel.find).toHaveBeenCalledWith(
        { workflowId: 'wf-1', tenantId: 'acme-corp' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(mockWorkflowRunModel.countDocuments).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        tenantId: 'acme-corp',
      });
    });
  });

  describe('findRunByWorkflowId', () => {
    it('should return the projection for a matching row without recording an audit event', async () => {
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

      const result = await service.findRunByWorkflowId('wf-1', 'acme-corp');

      expect(mockWorkflowRunModel.findOne).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        tenantId: 'acme-corp',
      });
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: id.toString(),
        workflowId: 'wf-1',
        status: 'running',
        currentStep: undefined,
        errorMessage: undefined,
        createdAt: run.createdAt,
      });
    });

    it('should return null when no row matches', async () => {
      mockWorkflowRunModel.findOne.mockResolvedValueOnce(null);

      const result = await service.findRunByWorkflowId('wf-1', 'tenant-a');

      expect(mockWorkflowRunModel.findOne).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        tenantId: 'tenant-a',
      });
      expect(result).toBeNull();
    });
  });

  describe('peekRun', () => {
    it('should refresh the status from the live engine without recording an audit event', async () => {
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
      mockWorkflowEngine.status.mockResolvedValueOnce({ id: 'wf-1', status: 'completed' });

      const result = await service.peekRun(id.toString(), 'tenant-a');

      expect(mockWorkflowEngine.status).toHaveBeenCalledWith('wf-1');
      expect(result.status).toBe('completed');
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  describe('streamRun', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const buildRun = (overrides: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      workflowId: 'wf-1',
      status: 'running',
      currentStep: undefined,
      errorMessage: undefined,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      ...overrides,
    });

    const emptyApprovalsPage = { docs: [], count: 0 };

    it('should record one audit row on open, then emit the first run and approvals events', async () => {
      const run = buildRun();
      mockWorkflowRunModel.findOne.mockResolvedValue(run);
      mockWorkflowEngine.status.mockRejectedValue(new Error('no live handle'));
      mockApprovalsService.peekPending.mockResolvedValue(emptyApprovalsPage);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      const subscription = service
        .streamRun(run._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);

      expect(mockAuditService.record).toHaveBeenCalledTimes(1);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'workflow-runs.viewed',
        actorId: 'actor-1',
        subject: { entityType: 'WorkflowRun', entityId: run._id.toString() },
        tenantId: 'tenant-a',
      });
      const runEvent = events.find((event) => event.type === 'run');
      const approvalsEvent = events.find((event) => event.type === 'approvals');
      expect(runEvent?.data).toEqual(expect.objectContaining({ status: 'running' }));
      expect(approvalsEvent?.data).toEqual({ docs: [], count: 0 });
      expect(mockApprovalsService.peekPending).toHaveBeenCalledWith(
        { skip: 0, limit: 20 },
        'tenant-a',
      );

      subscription.unsubscribe();
    });

    it('should not re-emit an unchanged approvals page on the next tick', async () => {
      const run = buildRun();
      mockWorkflowRunModel.findOne.mockResolvedValue(run);
      mockWorkflowEngine.status.mockRejectedValue(new Error('no live handle'));
      mockApprovalsService.peekPending.mockResolvedValue(emptyApprovalsPage);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      const subscription = service
        .streamRun(run._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      const countAfterFirstTick = events.length;

      await jest.advanceTimersByTimeAsync(WORKFLOW_RUN_STREAM_INTERVAL_MS);

      expect(events).toHaveLength(countAfterFirstTick);
      subscription.unsubscribe();
    });

    it('should emit an approvals event again once the pending inbox changes', async () => {
      const run = buildRun();
      mockWorkflowRunModel.findOne.mockResolvedValue(run);
      mockWorkflowEngine.status.mockRejectedValue(new Error('no live handle'));
      mockApprovalsService.peekPending.mockResolvedValueOnce(emptyApprovalsPage).mockResolvedValue({
        docs: [
          {
            id: 'approval-1',
            subject: { entityType: 'Conflict', entityId: 'c-1' },
            action: 'resolve_conflict',
            summary: 'Resolve it',
            state: 'pending',
            createdAt: new Date('2026-07-01T00:00:00.000Z'),
          },
        ],
        count: 1,
      });
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      const subscription = service
        .streamRun(run._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(WORKFLOW_RUN_STREAM_INTERVAL_MS);

      const approvalsEvents = events.filter((event) => event.type === 'approvals');
      expect(approvalsEvents).toHaveLength(2);
      expect((approvalsEvents[1].data as { count: number }).count).toBe(1);
      subscription.unsubscribe();
    });

    it('should emit a heartbeat event on its own 15s interval', async () => {
      const run = buildRun();
      mockWorkflowRunModel.findOne.mockResolvedValue(run);
      mockWorkflowEngine.status.mockRejectedValue(new Error('no live handle'));
      mockApprovalsService.peekPending.mockResolvedValue(emptyApprovalsPage);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      const subscription = service
        .streamRun(run._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(SSE_HEARTBEAT_INTERVAL_MS);

      expect(events.some((event) => event.type === 'heartbeat')).toBe(true);
      subscription.unsubscribe();
    });

    it('should emit the terminal run event and then complete, tearing down the approvals and heartbeat timers', async () => {
      const run = buildRun();
      mockWorkflowRunModel.findOne
        .mockResolvedValueOnce(run) // opened$'s existence-gating peek
        .mockResolvedValueOnce(run) // first tick, still running
        .mockResolvedValueOnce({ ...run, status: 'completed' }); // second tick, terminal
      mockWorkflowEngine.status.mockRejectedValue(new Error('no live handle'));
      mockApprovalsService.peekPending.mockResolvedValue(emptyApprovalsPage);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];
      let completed = false;

      service.streamRun(run._id.toString(), 'actor-1', 'tenant-a').subscribe({
        next: (event) => events.push(event),
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(WORKFLOW_RUN_STREAM_INTERVAL_MS);

      expect(completed).toBe(true);
      const runEvents = events.filter((event) => event.type === 'run');
      const lastRunEvent = runEvents[runEvents.length - 1];
      expect(lastRunEvent.type).toBe('run');
      expect(lastRunEvent.data).toEqual(expect.objectContaining({ status: 'completed' }));
      expect(events.some((event) => event.type === 'heartbeat')).toBe(false);
    });

    it('should emit a terminal error event carrying a fixed client-facing message, never the raw internal error, and log the real error server-side, recording no audit row', async () => {
      mockWorkflowRunModel.findOne.mockResolvedValueOnce(null);
      const id = new Types.ObjectId().toString();
      const events: MessageEvent[] = [];
      let completed = false;

      service.streamRun(id, 'actor-1', 'tenant-a').subscribe({
        next: (event) => events.push(event),
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(completed).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect((events[0].data as { message: string }).message).toBe(SSE_STREAM_ERROR_MESSAGE);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should stringify a non-Error rejection rather than reading a `.message` that does not exist', async () => {
      // rxjs/Mongoose never guarantee the rejection is an `Error` instance — this covers the
      // `String(error)` branch of `error instanceof Error ? error.message : String(error)`.
      mockWorkflowRunModel.findOne.mockRejectedValueOnce('a plain string rejection');
      const id = new Types.ObjectId().toString();
      const events: MessageEvent[] = [];

      service.streamRun(id, 'actor-1', 'tenant-a').subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);

      expect(events[0].type).toBe('error');
      expect((events[0].data as { message: string }).message).toBe(SSE_STREAM_ERROR_MESSAGE);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('a plain string rejection'),
      );
    });
  });
});
