import type { MessageEvent } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { AnswerNotFoundException } from '../../../../src/features/evidence/qa/exceptions/qa.exception';
import { ANSWER_STREAM_INTERVAL_MS } from '../../../../src/features/evidence/qa/qa.constant';
import { QaService } from '../../../../src/features/evidence/qa/qa.service';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_REAUTH_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
} from '../../../../src/shared/constants/sse.constant';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('QaService', () => {
  let service: QaService;
  const mockAnswerModel = getMockModel();
  const mockUserModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn() };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QaService,
        { provide: getModelToken(Answer.name), useValue: mockAnswerModel },
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
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
        role: UserRole.Member,
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
      const verificationReport = {
        verifiedClaimCount: 1,
        totalClaimCount: 2,
        droppedClaims: [{ statement: 'a dropped claim', reason: 'quote mismatch' }],
      };
      mockAnswerModel.findOne.mockResolvedValueOnce({
        _id: answerId,
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome,
        claimCoverage: 1,
        verificationReport,
        claims: [{ statement: 's', citations: [citation] }],
        conflictIds: [conflictId],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        retrievedChunkIds: ['chunk-1', 'chunk-2'],
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
        verificationReport,
        citations: [citation],
        conflictIds: [conflictId.toString()],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        retrievedChunkCount: 2,
      });
    });

    it('should omit outcome and verificationReport for a non-completed answer even when both are present on the document', async () => {
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
        verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
        claims: [],
        conflictIds: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        retrievedChunkIds: [],
      });
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.getAnswerById(answerId.toString(), 'actor', 'tenant-a');

      expect(result.outcome).toBeUndefined();
      expect(result.verificationReport).toBeUndefined();
      expect(result.citations).toEqual([]);
      expect(result.conflictIds).toEqual([]);
      expect(result.retrievedChunkCount).toBeUndefined();
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

  describe('listByTenant', () => {
    const buildAnswerDoc = (overrides: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      questionText: 'What is the cap rate?',
      runStatus: 'completed',
      outcome: { kind: 'answered' as const, claims: [] },
      claimCoverage: 1,
      verificationReport: { verifiedClaimCount: 0, totalClaimCount: 0, droppedClaims: [] },
      claims: [],
      conflictIds: [],
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      retrievedChunkIds: ['chunk-1'],
      ...overrides,
    });

    it('should list answers for a tenant with no filter, newest first, and record no audit event', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.find.mockResolvedValueOnce([answer]);
      mockAnswerModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.listByTenant({ skip: 0, limit: 20 }, 'actor', 'tenant-a');

      expect(mockAnswerModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAnswerModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(result.count).toBe(1);
      expect(result.docs).toEqual([
        {
          id: answer._id.toString(),
          questionText: answer.questionText,
          runStatus: 'completed',
          outcome: answer.outcome,
          claimCoverage: answer.claimCoverage,
          verificationReport: answer.verificationReport,
          citations: [],
          conflictIds: [],
          createdAt: answer.createdAt,
          usage: undefined,
          retrievedChunkCount: 1,
        },
      ]);
    });

    it('should scope the lookup to the given tenantId', async () => {
      mockAnswerModel.find.mockResolvedValueOnce([]);
      mockAnswerModel.countDocuments.mockResolvedValueOnce(0);

      await service.listByTenant({ skip: 0, limit: 20 }, 'actor', 'tenant-b');

      expect(mockAnswerModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-b' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAnswerModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-b' });
    });

    it('should add a runStatus predicate when the filter is provided', async () => {
      mockAnswerModel.find.mockResolvedValueOnce([]);
      mockAnswerModel.countDocuments.mockResolvedValueOnce(0);

      await service.listByTenant({ skip: 0, limit: 20, runStatus: 'failed' }, 'actor', 'tenant-a');

      const expectedFilter = { tenantId: 'tenant-a', runStatus: 'failed' };
      expect(mockAnswerModel.find).toHaveBeenCalledWith(expectedFilter, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAnswerModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });

    it('should present a queued row from the same list with outcome and verificationReport omitted', async () => {
      const answer = buildAnswerDoc({
        runStatus: 'queued',
        outcome: undefined,
        claimCoverage: undefined,
        verificationReport: undefined,
      });
      mockAnswerModel.find.mockResolvedValueOnce([answer]);
      mockAnswerModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.listByTenant({ skip: 0, limit: 20 }, 'actor', 'tenant-a');

      expect(result.docs[0].outcome).toBeUndefined();
      expect(result.docs[0].verificationReport).toBeUndefined();
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
      retrievedChunkIds: [],
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

    it('should emit a terminal error event carrying a fixed client-facing message, never the raw internal error, and log the real error server-side, recording no audit row', async () => {
      mockAnswerModel.findOne.mockResolvedValueOnce(null);
      const id = new Types.ObjectId().toString();
      const events: MessageEvent[] = [];
      let completed = false;

      service.streamAnswer(id, 'actor-1', 'tenant-a').subscribe({
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
      mockAnswerModel.findOne.mockRejectedValueOnce('a plain string rejection');
      const id = new Types.ObjectId().toString();
      const events: MessageEvent[] = [];

      service.streamAnswer(id, 'actor-1', 'tenant-a').subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);

      expect(events[0].type).toBe('error');
      expect((events[0].data as { message: string }).message).toBe(SSE_STREAM_ERROR_MESSAGE);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('a plain string rejection'),
      );
    });

    it('should complete the stream once a re-auth tick finds the connecting user gone, without a terminal error event', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);
      mockUserModel.findById.mockResolvedValue(null);
      const events: MessageEvent[] = [];
      let completed = false;

      service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe({
        next: (event) => events.push(event),
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(SSE_REAUTH_INTERVAL_MS);

      expect(mockUserModel.findById).toHaveBeenCalledWith('actor-1');
      expect(completed).toBe(true);
      // The invalidated session ends the stream cleanly via `takeUntil` — no `catchError` fallback
      // event is owed the way a Mongo failure would get one; the answer never reached a terminal
      // runStatus of its own, so completion here is entirely `reauthTicks$`'s doing.
      expect(events.some((event) => event.type === 'error')).toBe(false);
    });

    it('should complete the stream once a re-auth tick finds the connecting user moved to a different tenant', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);
      mockUserModel.findById.mockResolvedValue({ tenantId: 'tenant-b' });
      let completed = false;

      service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe({
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(SSE_REAUTH_INTERVAL_MS);

      expect(completed).toBe(true);
    });

    it('should not complete the stream while re-auth ticks keep resolving the same tenant', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);
      mockUserModel.findById.mockResolvedValue({ tenantId: 'tenant-a' });
      let completed = false;

      const subscription = service
        .streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a')
        .subscribe({
          complete: () => {
            completed = true;
          },
        });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(SSE_REAUTH_INTERVAL_MS);

      expect(completed).toBe(false);
      subscription.unsubscribe();
    });
  });
});
