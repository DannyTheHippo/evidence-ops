import type { MessageEvent } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { User } from '../../../../src/database/schemas/administration/user/user.schema';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { AnswerNotFoundException } from '../../../../src/features/evidence/qa/exceptions/qa.exception';
import { ANSWER_STREAM_INTERVAL_MS } from '../../../../src/features/evidence/qa/qa.constant';
import { QaService } from '../../../../src/features/evidence/qa/qa.service';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_REAUTH_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
  SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS,
} from '../../../../src/shared/constants/sse.constant';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { locateQuote } from '../../../../src/shared/utils/locate-quote.util';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

describe('QaService', () => {
  let service: QaService;
  const mockAnswerModel = getMockModel();
  const mockUserModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn() };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QaService,
        { provide: getModelToken(Answer.name), useValue: mockAnswerModel },
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: TypedConfigService, useValue: getMockTypedConfig() },
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
        withdrawnCitedDocVersionIds: [],
      });
      // `citation.docVersionId` ('v1') is not a valid ObjectId — `resolveWithdrawnDocVersionIds`
      // filters it out and short-circuits before ever querying DocumentVersion.
      expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
    });

    // Pins the three-part property a spoofed quote must never break: the raw bidi-override and
    // zero-width bytes still verify against the chunk they were cited from (verification runs on
    // stored bytes), the stored document itself is never mutated by serving a response, and only
    // the response the browser actually renders is neutralized — in both the flattened `citations`
    // field and the nested `outcome.claims[].citations[].quote` this same citation also appears
    // under.
    it('should neutralize a bidi-override and zero-width character in a citation quote for display, while the raw bytes still verify and the stored document stays untouched', async () => {
      const answerId = new Types.ObjectId();
      const actorId = new Types.ObjectId().toString();
      const rightToLeftOverride = String.fromCharCode(0x202e);
      const zeroWidthSpace = String.fromCharCode(0x200b);
      const rawQuote = `NOI $1,234,567${zeroWidthSpace} was reported${rightToLeftOverride}.`;
      const neutralizedQuote = 'NOI $1,234,567 was reported.';
      const chunkText = `The annual ${rawQuote} for the property.`;
      const citation = {
        docVersionId: 'v1',
        sha256: 'a'.repeat(64),
        chunkId: 'chunk-1',
        locator: { kind: 'pdf-page' as const, page: 1, extractorVersion: 'v1' },
        quote: rawQuote,
      };
      const outcome = {
        kind: 'answered' as const,
        claims: [{ statement: 's', citations: [citation] }],
      };
      const storedAnswer = {
        _id: answerId,
        questionText: 'What is the NOI?',
        runStatus: 'completed',
        outcome,
        claimCoverage: 1,
        verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
        claims: [{ statement: 's', citations: [citation] }],
        conflictIds: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        retrievedChunkIds: ['chunk-1'],
      };
      mockAnswerModel.findOne.mockResolvedValueOnce(storedAnswer);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      // Verification runs on the raw stored bytes, never the display form — the bidi override and
      // zero-width space intact.
      expect(locateQuote(rawQuote, chunkText)).toEqual({ kind: 'exact', similarity: 1 });

      const result = await service.getAnswerById(answerId.toString(), actorId, 'tenant-a');

      expect(result.citations).toEqual([{ ...citation, quote: neutralizedQuote }]);
      expect(result.outcome).toEqual({
        kind: 'answered',
        claims: [{ statement: 's', citations: [{ ...citation, quote: neutralizedQuote }] }],
      });
      // Storage stays byte-faithful — the document the service read from still carries the raw
      // bidi/zero-width bytes, unmutated by serving this response.
      expect(storedAnswer.claims[0].citations[0].quote).toBe(rawQuote);
      expect(storedAnswer.outcome.claims[0].citations[0].quote).toBe(rawQuote);
    });

    it('should leave a non-answered outcome untouched — insufficient_evidence carries no citations to neutralize', async () => {
      const answerId = new Types.ObjectId();
      const outcome = { kind: 'insufficient_evidence' as const, reason: 'No evidence found.' };
      mockAnswerModel.findOne.mockResolvedValueOnce({
        _id: answerId,
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome,
        claimCoverage: 0,
        verificationReport: { verifiedClaimCount: 0, totalClaimCount: 0, droppedClaims: [] },
        claims: [],
        conflictIds: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        retrievedChunkIds: [],
      });
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.getAnswerById(answerId.toString(), 'actor', 'tenant-a');

      expect(result.outcome).toEqual(outcome);
    });

    it('should omit outcome when a completed answer carries no outcome at all', async () => {
      const answerId = new Types.ObjectId();
      mockAnswerModel.findOne.mockResolvedValueOnce({
        _id: answerId,
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome: undefined,
        claimCoverage: undefined,
        verificationReport: undefined,
        claims: [],
        conflictIds: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        retrievedChunkIds: [],
      });
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.getAnswerById(answerId.toString(), 'actor', 'tenant-a');

      expect(result.outcome).toBeUndefined();
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
      expect(result.withdrawnCitedDocVersionIds).toEqual([]);
    });

    it('should report a cited document version as withdrawn, and leave a live one out', async () => {
      const answerId = new Types.ObjectId();
      const withdrawnVersionId = new Types.ObjectId();
      const liveVersionId = new Types.ObjectId();
      const withdrawnCitation = {
        docVersionId: withdrawnVersionId.toString(),
        sha256: 'a'.repeat(64),
        chunkId: 'chunk-1',
        locator: { kind: 'pdf-page' as const, page: 1, extractorVersion: 'v1' },
        quote: 'the cap rate is 6.10%',
      };
      const liveCitation = {
        docVersionId: liveVersionId.toString(),
        sha256: 'b'.repeat(64),
        chunkId: 'chunk-2',
        locator: { kind: 'pdf-page' as const, page: 2, extractorVersion: 'v1' },
        quote: 'occupancy was 94%',
      };
      mockAnswerModel.findOne.mockResolvedValueOnce({
        _id: answerId,
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome: { kind: 'answered' as const, claims: [] },
        claimCoverage: 1,
        verificationReport: { verifiedClaimCount: 2, totalClaimCount: 2, droppedClaims: [] },
        claims: [
          { statement: 's1', citations: [withdrawnCitation] },
          { statement: 's2', citations: [liveCitation] },
        ],
        conflictIds: [],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        retrievedChunkIds: ['chunk-1', 'chunk-2'],
      });
      // Only the withdrawn version comes back — the query's own `withdrawnAt: { $exists: true }`
      // predicate means a live version is simply absent from the result, never returned with a
      // falsy flag.
      mockDocumentVersionModel.find.mockResolvedValueOnce([{ _id: withdrawnVersionId }]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.getAnswerById(answerId.toString(), 'actor', 'tenant-a');

      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        {
          _id: { $in: [withdrawnVersionId, liveVersionId] },
          tenantId: 'tenant-a',
          withdrawnAt: { $exists: true },
        },
        { _id: 1 },
      );
      expect(result.withdrawnCitedDocVersionIds).toEqual([withdrawnVersionId.toString()]);
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
          withdrawnCitedDocVersionIds: [],
        },
      ]);
      // No citations on this page — the batched withdrawal lookup short-circuits before ever
      // querying DocumentVersion.
      expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
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

    it('should batch the withdrawal lookup once for the whole page, not once per row, and tag only the withdrawn citation', async () => {
      const withdrawnVersionId = new Types.ObjectId();
      const liveVersionId = new Types.ObjectId();
      const answerOne = buildAnswerDoc({
        claims: [
          {
            statement: 's1',
            citations: [{ docVersionId: withdrawnVersionId.toString(), quote: 'q1' }],
          },
        ],
      });
      const answerTwo = buildAnswerDoc({
        claims: [
          { statement: 's2', citations: [{ docVersionId: liveVersionId.toString(), quote: 'q2' }] },
        ],
      });
      mockAnswerModel.find.mockResolvedValueOnce([answerOne, answerTwo]);
      mockAnswerModel.countDocuments.mockResolvedValueOnce(2);
      mockDocumentVersionModel.find.mockResolvedValueOnce([{ _id: withdrawnVersionId }]);

      const result = await service.listByTenant({ skip: 0, limit: 20 }, 'actor', 'tenant-a');

      expect(mockDocumentVersionModel.find).toHaveBeenCalledTimes(1);
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        {
          _id: { $in: [withdrawnVersionId, liveVersionId] },
          tenantId: 'tenant-a',
          withdrawnAt: { $exists: true },
        },
        { _id: 1 },
      );
      expect(result.docs[0].withdrawnCitedDocVersionIds).toEqual([withdrawnVersionId.toString()]);
      expect(result.docs[1].withdrawnCitedDocVersionIds).toEqual([]);
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

    it('should not record a second audit row when the same answer stream reopens within the dedupe window', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);

      const first = service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe();
      await jest.advanceTimersByTimeAsync(0);
      first.unsubscribe();

      const second = service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe();
      await jest.advanceTimersByTimeAsync(0);
      second.unsubscribe();

      expect(mockAuditService.record).toHaveBeenCalledTimes(1);
    });

    it('should record another audit row once the dedupe window has fully elapsed', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockAuditService.record.mockResolvedValue(undefined);

      const first = service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe();
      await jest.advanceTimersByTimeAsync(0);
      first.unsubscribe();

      await jest.advanceTimersByTimeAsync(SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS);

      const second = service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe();
      await jest.advanceTimersByTimeAsync(0);
      second.unsubscribe();

      expect(mockAuditService.record).toHaveBeenCalledTimes(2);
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

    it('should complete the stream once it has been open for the configured max lifetime, even with an answer that never reaches a terminal status', async () => {
      const answer = buildAnswerDoc();
      mockAnswerModel.findOne.mockResolvedValue(answer);
      mockUserModel.findById.mockResolvedValue({ tenantId: 'tenant-a' });
      mockAuditService.record.mockResolvedValue(undefined);
      let completed = false;

      service.streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a').subscribe({
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(completed).toBe(false);

      await jest.advanceTimersByTimeAsync(getMockTypedConfig().sse.maxStreamLifetimeMs);

      expect(completed).toBe(true);
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

    // Regression for the "query per tick per open connection" trap: `resolveWithdrawnDocVersionIds`
    // must be gated on the answer actually carrying citations, which is only true once completed —
    // otherwise every 1.5s tick of every open SSE connection would pay for a DocumentVersion query.
    it('should query DocumentVersion for withdrawal at most once, on the terminal tick where citations first appear', async () => {
      const versionId = new Types.ObjectId();
      const answer = buildAnswerDoc();
      const completedAnswer = buildAnswerDoc({
        _id: answer._id,
        runStatus: 'completed',
        claims: [
          { statement: 's', citations: [{ docVersionId: versionId.toString(), quote: 'q' }] },
        ],
      });
      mockAnswerModel.findOne.mockResolvedValueOnce(answer); // opened$'s existence-gating peek
      mockAnswerModel.findOne.mockResolvedValueOnce(answer); // first tick, still running, no citations
      mockAnswerModel.findOne.mockResolvedValueOnce(completedAnswer); // second tick, terminal, cited
      mockDocumentVersionModel.find.mockResolvedValueOnce([{ _id: versionId }]);
      mockAuditService.record.mockResolvedValue(undefined);
      const events: MessageEvent[] = [];

      service
        .streamAnswer(answer._id.toString(), 'actor-1', 'tenant-a')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(ANSWER_STREAM_INTERVAL_MS);

      expect(mockDocumentVersionModel.find).toHaveBeenCalledTimes(1);
      const lastEvent = events[events.length - 1];
      expect(lastEvent.data).toEqual(
        expect.objectContaining({ withdrawnCitedDocVersionIds: [versionId.toString()] }),
      );
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
