import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { ConflictsService } from '../../../../src/features/evidence/conflicts/conflicts.service';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('ConflictsService', () => {
  let service: ConflictsService;

  const mockExtractedFactModel = getMockModel();
  const mockConflictModel = getMockModel();
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const buildFact = (
    factKey: { entity: string; metric: string; period: string },
    value: { amount: number; unit: string },
  ) => ({
    _id: new Types.ObjectId(),
    factKey,
    value,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConflictsService,
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ConflictsService>(ConflictsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should default tenantId to the shared tenant constant when none is provided', async () => {
    mockExtractedFactModel.find.mockResolvedValueOnce([]);

    const result = await service.scanForConflicts();

    expect(mockExtractedFactModel.find).toHaveBeenCalledWith({ tenantId: DEFAULT_TENANT_ID });
    expect(mockConflictModel.find).not.toHaveBeenCalled();
    expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
  });

  it('should return conflictsCreated 0 without querying existing conflicts when normalized values agree within tolerance', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    // 5.25% vs 5.30% is a 5bp spread — well inside cap_rate's 25bp absolute tolerance.
    const facts = [
      buildFact(factKey, { amount: 5.25, unit: 'percent' }),
      buildFact(factKey, { amount: 5.3, unit: 'percent' }),
    ];
    mockExtractedFactModel.find.mockResolvedValueOnce(facts);

    const result = await service.scanForConflicts(tenantId);

    expect(mockExtractedFactModel.find).toHaveBeenCalledWith({ tenantId });
    expect(mockConflictModel.find).not.toHaveBeenCalled();
    expect(mockConflictModel.insertMany).not.toHaveBeenCalled();
    expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
  });

  it('should persist a conflict for facts whose normalized values diverge beyond tolerance', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    // 5.25% vs 6.10% is an 85bp spread — well past cap_rate's 25bp absolute tolerance.
    const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
    const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
    mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);
    mockConflictModel.find.mockResolvedValueOnce([]);
    mockConflictModel.insertMany.mockResolvedValueOnce([]);

    const result = await service.scanForConflicts(tenantId);

    expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId, status: 'open' });
    expect(mockConflictModel.insertMany).toHaveBeenCalledTimes(1);
    const insertManyMock = mockConflictModel.insertMany as jest.Mock<
      Promise<unknown[]>,
      [
        {
          factKey: { entity: string; metric: string; period: string };
          factIds: Types.ObjectId[];
          magnitude: number;
          status: string;
          tenantId: string;
        }[],
      ]
    >;
    const insertedConflicts = insertManyMock.mock.calls[0][0];
    expect(insertedConflicts).toHaveLength(1);
    expect(insertedConflicts[0].factKey).toEqual(factKey);
    expect(insertedConflicts[0].factIds.map((id) => id.toString())).toEqual([
      factLow._id.toString(),
      factHigh._id.toString(),
    ]);
    expect(insertedConflicts[0].magnitude).toBeCloseTo(0.0085, 4);
    expect(insertedConflicts[0].status).toBe('open');
    expect(insertedConflicts[0].tenantId).toBe(tenantId);
    expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
  });

  it('should skip a candidate whose group already has an open Conflict record', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
    const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
    mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);
    mockConflictModel.find.mockResolvedValueOnce([{ factKey }]);

    const result = await service.scanForConflicts(tenantId);

    expect(mockConflictModel.insertMany).not.toHaveBeenCalled();
    expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
  });

  it('should skip an un-normalizable fact, log it with real context, and still create a conflict for the rest of its group', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
    const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
    // Reproduces the live `npm run eval -- --record` failure: a fact sharing the same conflict
    // group carries an ontology-unrecognized unit ('usd' is not one of cap_rate's declared units)
    // and must not abort detection of the genuine factLow/factHigh conflict alongside it.
    const unnormalizableFact = buildFact(factKey, { amount: 250, unit: 'usd' });
    mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh, unnormalizableFact]);
    mockConflictModel.find.mockResolvedValueOnce([]);
    mockConflictModel.insertMany.mockResolvedValueOnce([]);

    const result = await service.scanForConflicts(tenantId);

    expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 1 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(unnormalizableFact._id.toString()),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("metric 'cap_rate'"));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("unit 'usd'"));
  });

  describe('findConflictedFactGroupsForChunks', () => {
    it('should return an empty array without querying the model when chunkIds is empty', async () => {
      const result = await service.findConflictedFactGroupsForChunks([], 'acme-corp');

      expect(result).toEqual([]);
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
    });

    it('should query every given chunk id verbatim, scoped to tenant', async () => {
      // `chunkId` is now a content-addressed string (`computeChunkId`), not an ObjectId, so there
      // is no "invalid ObjectId" shape to filter out any more.
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      const result = await service.findConflictedFactGroupsForChunks(
        ['chunk-a', 'chunk-b'],
        'acme-corp',
      );

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { chunkId: { $in: ['chunk-a', 'chunk-b'] }, tenantId: 'acme-corp' },
        { _id: 1 },
      );
      expect(mockConflictModel.find).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should return an empty array when the touched fact has no open conflict', async () => {
      const chunkId = 'chunk-a';
      const touchedFactId = new Types.ObjectId();
      mockExtractedFactModel.find.mockResolvedValueOnce([{ _id: touchedFactId }]);
      mockConflictModel.find.mockResolvedValueOnce([]);

      const result = await service.findConflictedFactGroupsForChunks([chunkId], 'acme-corp');

      expect(mockConflictModel.find).toHaveBeenCalledWith({
        tenantId: 'acme-corp',
        status: 'open',
        factIds: { $in: [touchedFactId] },
      });
      expect(result).toEqual([]);
    });

    it('should return every value of an open conflict touched by the given chunks', async () => {
      const chunkId = 'chunk-a';
      const touchedFactId = new Types.ObjectId();
      const otherChunkId = 'chunk-b';
      const otherFactId = new Types.ObjectId();
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      const touchedFact = {
        ...buildFact(factKey, { amount: 5.25, unit: 'percent' }),
        _id: touchedFactId,
        chunkId,
      };
      const otherFact = {
        ...buildFact(factKey, { amount: 6.1, unit: 'percent' }),
        _id: otherFactId,
        chunkId: otherChunkId,
      };
      mockExtractedFactModel.find
        .mockResolvedValueOnce([{ _id: touchedFactId }])
        .mockResolvedValueOnce([touchedFact, otherFact]);
      const conflict = {
        _id: new Types.ObjectId(),
        factKey,
        factIds: [touchedFactId, otherFactId],
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);

      const result = await service.findConflictedFactGroupsForChunks([chunkId], 'acme-corp');

      expect(result).toEqual([
        {
          conflictId: conflict._id.toString(),
          factKey,
          values: [
            { value: 5.25, unit: 'percent', sourceChunkId: chunkId },
            { value: 6.1, unit: 'percent', sourceChunkId: otherChunkId },
          ],
        },
      ]);
    });

    it('should throw InternalServerErrorException when a conflict references a fact that no longer resolves', async () => {
      const chunkId = new Types.ObjectId();
      const touchedFactId = new Types.ObjectId();
      const missingFactId = new Types.ObjectId();
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      mockExtractedFactModel.find
        .mockResolvedValueOnce([{ _id: touchedFactId }])
        .mockResolvedValueOnce([
          { ...buildFact(factKey, { amount: 5.25, unit: 'percent' }), _id: touchedFactId, chunkId },
        ]);
      const conflict = {
        _id: new Types.ObjectId(),
        factKey,
        factIds: [touchedFactId, missingFactId],
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);

      let caught: unknown;
      try {
        await service.findConflictedFactGroupsForChunks([chunkId.toString()], 'acme-corp');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InternalServerErrorException);
      expect((caught as Error).message).toMatch(/references 2 fact\(s\), but only 1/);
    });
  });

  describe('list', () => {
    it('should page conflicts for the default tenant and record an audit event scoped to the actor', async () => {
      const actorId = new Types.ObjectId().toString();
      const factIdA = new Types.ObjectId();
      const factIdB = new Types.ObjectId();
      const conflict = {
        _id: new Types.ObjectId(),
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        factIds: [factIdA, factIdB],
        magnitude: 0.0085,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId);

      expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId: DEFAULT_TENANT_ID }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockConflictModel.countDocuments).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'conflicts.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result).toEqual({
        docs: [
          {
            id: conflict._id.toString(),
            factKey: conflict.factKey,
            factIds: [factIdA.toString(), factIdB.toString()],
            magnitude: 0.0085,
            status: 'open',
            createdAt: conflict.createdAt,
          },
        ],
        count: 1,
      });
    });

    it('should scope the query to an explicit tenantId when provided', async () => {
      const actorId = new Types.ObjectId().toString();
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'acme-corp');

      expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId: 'acme-corp' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(result).toEqual({ docs: [], count: 0 });
    });
  });
});
