import type { MessageEvent } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { AnswerNotFoundException } from '../../../../src/features/evidence/qa/exceptions/qa.exception';
import { ANSWER_STREAM_INTERVAL_MS } from '../../../../src/features/evidence/qa/qa.constant';
import { QaService } from '../../../../src/features/evidence/qa/qa.service';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import { SSE_HEARTBEAT_INTERVAL_MS } from '../../../../src/shared/constants/sse.constant';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('QaService', () => {
  let service: QaService;
  const mockAnswerModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn() };
  const mockAuditService = { record: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QaService,
        { provide: getModelToken(Answer.name), useValue: mockAnswerModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();

    service = module.get<QaService>(QaService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('startQuestion', () => {
    it('should create a queued Answer, start the workflow, and record an audit event', async () => {
      const answerId = new Types.ObjectId();
      const actorId = new Types.ObjectId().toString();
      mockAnswerModel.create.mockResolvedValueOnce({ _id: answerId, runStatus: 'queued' });
      mockWorkflowEngine.start.mockResolvedValueOnce({ id: 'wf-1', status: 'running' });
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.startQuestion({
        questionText: 'What is the cap rate?',
        actorId,
        tenantId: 'tenant-a',
      });

      expect(mockAnswerModel.create).toHaveBeenCalledWith({
        questionText: 'What is the cap rate?',
        runStatus: 'queued',
        tenantId: 'tenant-a',
      });
      expect(mockWorkflowEngine.start).toHaveBeenCalledWith('answerQuestion', {
        answerId: answerId.toString(),
        questionText: 'What is the cap rate?',
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'qa.question.started',
        actorId,
        subject: { entityType: 'Answer', entityId: answerId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual({ id: answerId.toString(), runStatus: 'queued' });
    });
  });

  describe('getAnswerById', () => {
    it('should throw AnswerNotFoundException for a syntactically invalid id', async () => {
      await expect(
        service.getAnswerById('not-an-object-id', 'actor', 'tenant-a'),
      ).rejects.toBeInstanceOf(AnswerNotFoundException);
      expect(mockAnswerModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw AnswerNotFoundException when no Answer document exists for a valid id', async () => {
      const id = new Types.ObjectId().toString();
      mockAnswerModel.findOne.mockResolvedValueOnce(null);

      await expect(service.getAnswerById(id, 'actor', 'tenant-a')).rejects.toBeInstanceOf(
        AnswerNotFoundException,
      );
    });

    it('should throw AnswerNotFoundException when the Answer belongs to another tenant', async () => {
      const id = new Types.ObjectId().toString();
      // The mock model does not filter by predicate — the not-found outcome here asserts that
      // `getAnswerById` queries with the tenant predicate at all, not that a real Mongo would
      // exclude the row; that scoping-is-correctness argument lives in the query call assertion.
      mockAnswerModel.findOne.mockResolvedValueOnce(null);

      await expect(service.getAnswerById(id, 'actor', 'tenant-b')).rejects.toBeInstanceOf(
        AnswerNotFoundException,
      );
      expect(mockAnswerModel.findOne).toHaveBeenCalledWith({ _id: id, tenantId: 'tenant-b' });
    });

    it('should present outcome and citations for a completed answer and record an audit event', async () => {
      const answerId = new Types.ObjectId();
      const actorId = new Types.ObjectId().toString();
      const conflictId = new Types.ObjectId();
      const citation = {
        docVersionId: 'v1',
        sha256: 'a'.repeat(64),
        chunkId: 'chunk-1',
        locator: { kind: 'pdf-page' as const, page: 1, extractorVersion: 'v1' },
        quote: 'the cap rate is 6.10%',
      };
      const outcome = {
        kind: 'answered' as const,
        claims: [{ statement: 's', citations: [citation] }],
      };
      mockAnswerModel.findOne.mockResolvedValueOnce({
        _id: answerId,
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome,
        claimCoverage: 1,
        claims: [{ statement: 's', citations: [citation] }],
        conflictIds: [conflictId],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.getAnswerById(answerId.toString(), actorId, 'tenant-a');

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'qa.answer.viewed',
        actorId,
        subject: { entityType: 'Answer', entityId: answerId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual({
        id: answerId.toString(),
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome,
        claimCoverage: 1,
        citations: [citation],
        conflictIds: [conflictId.toString()],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });
    });

    it('should omit outcome for a non-completed answer even when one is present on the document', async () => {
      const answerId = new Types.ObjectId();
      const citation = {
        docVersionId: 'v1',
        sha256: 'a'.repeat(64),
        chunkId: 'chunk-1',
        locator: { kind: 'pdf-page' as const, page: 1, extractorVersion: 'v1' },
        quote: 'the cap rate is 6.10%',
      };
      const outcome = {
        kind: 'answered' as const,
        claims: [{ statement: 's', citations: [citation] }],
      };
      mockAnswerModel.findOne.mockResolvedValueOnce({
        _id: answerId,
        questionText: 'What is the cap rate?',
        runStatus: 'queued',
        outcome,
        claimCoverage: undefined,
        claims: [],
        conflictIds: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.getAnswerById(answerId.toString(), 'actor', 'tenant-a');

      expect(result.outcome).toBeUndefined();
      expect(result.citations).toEqual([]);
      expect(result.conflictIds).toEqual([]);
    });
  });

  describe('peekAnswer', () => {
    it('should throw AnswerNotFoundException for a syntactically invalid id without querying', async () => {
      await expect(service.peekAnswer('not-an-object-id', 'tenant-a')).rejects.toBeInstanceOf(
        AnswerNotFoundException,
      );
      expect(mockAnswerModel.findOne).not.toHaveBeenCalled();
    });

    it('should return the answer envelope without recording an audit event', async () => {
      const answerId = new Types.ObjectId();
      mockAnswerModel.findOne.mockResolvedValueOnce({
        _id: answerId,
        questionText: 'What is the cap rate?',
        runStatus: 'running',
        claims: [],
        conflictIds: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });

      const result = await service.peekAnswer(answerId.toString(), 'tenant-a');

      expect(result.id).toBe(answerId.toString());
      expect(result.runStatus).toBe('running');
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  describe('streamAnswer', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const buildAnswerDoc = (overrides: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      questionText: 'What is the cap rate?',
      runStatus: 'running',
      claims: [],
      conflictIds: [],
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      ...overrides,
    });

    it('should record one audit row on open, gated on the answer existing, then emit the first answer event', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      const subscription = service
        .streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);

      expect(mockAuditService.record).toHaveBeenCalledTimes(1);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'qa.answer.viewed',
        actorId: 'actor-1',
        subject: { entityType: 'Answer', entityId: answer._id.toString() },
        tenantId: 'tenant-a',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('answer');
      expect(events[0].data).toEqual(expect.objectContaining({ runStatus: 'running' }));

      subscription.unsubscribe();
    });

    it('should not re-emit an unchanged answer on the next tick', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      const subscription = service
        .streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      const countAfterFirstTick = events.length;

      await jest.advanceTimersByTimeAsync(ANSWER_STREAM_INTERVAL_MS);

      expect(events).toHaveLength(countAfterFirstTick);
      subscription.unsubscribe();
    });

    it('should emit a heartbeat event on its own 15s interval', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      const subscription = service
        .streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(SSE_HEARTBEAT_INTERVAL_MS);

      expect(events.some((event) => event.type === 'heartbeat')).toBe(true);
      subscription.unsubscribe();
    });

    it('should emit the terminal answer event and then complete, without a later heartbeat', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValueOnce(answer); // opened$'s existence-gating peek
      mockAnswerModel.findOne.mockResolvedValueOnce(answer); // first tick, still running
      mockAnswerModel.findOne.mockResolvedValueOnce(
        buildAnswerDoc({ _id: answer._id, runStatus: 'completed' }),
      ); // second tick, terminal
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];
      let completed = false;

      service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe({
        next: (event) => events.push(event),
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(ANSWER_STREAM_INTERVAL_MS);

      expect(completed).toBe(true);
      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('answer');
      expect(lastEvent.data).toEqual(expect.objectContaining({ runStatus: 'completed' }));
      // The stream closed well before the 15s heartbeat interval elapsed (two 1.5s ticks) — no
      // heartbeat should have made it through before completion.
      expect(events.some((event) => event.type === 'heartbeat')).toBe(false);
    });

    it('should emit a terminal error event and complete when the initial peek fails, recording no audit row', async () => {
      mockAnswerModel.findOne.mockResolvedValueOnce(null);
      const events: MessageEvent[] = [];
      let completed = false;

      service.streamAnswer(new Types.ObjectId().toString(), 'actor-1', 'tenant-a').subscribe({
        next: (event) => events.push(event),
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(completed).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect((events[0].data as { message: string }).message).toContain('not found');
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });
});
