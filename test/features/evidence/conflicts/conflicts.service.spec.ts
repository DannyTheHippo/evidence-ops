import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { ConflictsService } from '../../../../src/features/evidence/conflicts/conflicts.service';
import {
  ConflictNotFoundException,
  InvalidConflictResolutionException,
} from '../../../../src/features/evidence/conflicts/exceptions/conflicts.exception';
import { WorkflowRunsService } from '../../../../src/features/evidence/workflow-runs/workflow-runs.service';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('ConflictsService', () => {
  let service: ConflictsService;

  const mockExtractedFactModel = getMockModel();
  const mockConflictModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn(), signal: jest.fn() };
  const mockWorkflowRunsService = { create: jest.fn(), findById: jest.fn() };
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

  /** `ConflictsService.scanForConflicts`'s full-scan path reads via a Mongoose `.cursor()`, not a
   * plain awaited `find()` — the mock model's `find` has to return something whose `.cursor()`
   * itself returns an async-iterable, matching what `for await` needs (see `get-mock-model.ts`'s
   * own `MockQueryChain.cursor` doc comment). */
  const asCursor = (facts: readonly unknown[]) => ({
    cursor: () =>
      // eslint-disable-next-line @typescript-eslint/require-await -- `MockQueryChain.cursor` is typed as `AsyncIterable`, matching the real Mongoose cursor, and a sync generator does not satisfy that type; yielding a fixed array needs no await.
      (async function* () {
        yield* facts;
      })(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConflictsService,
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: WorkflowRunsService, useValue: mockWorkflowRunsService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ConflictsService>(ConflictsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should default tenantId to the shared tenant constant and full-scan via a cursor when factKeys is omitted', async () => {
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([]));

    const result = await service.scanForConflicts();

    expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
      { tenantId: DEFAULT_TENANT_ID },
      { factKey: 1, value: 1 },
    );
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
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor(facts));

    const result = await service.scanForConflicts(tenantId);

    expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
      { tenantId },
      { factKey: 1, value: 1 },
    );
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
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
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
          groupKeyNormalized: string;
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
    expect(insertedConflicts[0].groupKeyNormalized).toBe(
      'northgate business park::cap_rate::2025-03',
    );
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
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
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
    mockExtractedFactModel.find.mockReturnValueOnce(
      asCursor([factLow, factHigh, unnormalizableFact]),
    );
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

  describe('incremental scan (factKeys given)', () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const groupKeyNormalized = 'northgate business park::cap_rate::2025-03';

    it('should query only the affected groups via a plain find, scoped to tenant and the normalized keys', async () => {
      const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
      const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
      mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.scanForConflicts(tenantId, [factKey]);

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId, groupKeyNormalized: { $in: [groupKeyNormalized] } },
        { factKey: 1, value: 1 },
      );
      expect(mockConflictModel.find).toHaveBeenCalledWith({
        tenantId,
        status: 'open',
        groupKeyNormalized: { $in: [groupKeyNormalized] },
      });
      expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
    });

    it('should dedupe repeated factKeys into one normalized group before querying', async () => {
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      await service.scanForConflicts(tenantId, [factKey, factKey]);

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId, groupKeyNormalized: { $in: [groupKeyNormalized] } },
        { factKey: 1, value: 1 },
      );
    });

    it('should run the incremental (cheap, no-op) path — never fall back to a full scan — when factKeys is an empty array', async () => {
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      const result = await service.scanForConflicts(tenantId, []);

      // `factKeys: []` is a real "this ingest produced zero facts" result, not "no factKeys given"
      // — it must still take the incremental branch (an `$in: []` query, resolving no facts) and
      // never the cursor-based full-scan path a `factKeys === undefined` check would fall back to.
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId, groupKeyNormalized: { $in: [] } },
        { factKey: 1, value: 1 },
      );
      expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
    });

    it('should produce the identical insertMany payload as a full scan over the same data', async () => {
      const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
      const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });

      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);
      await service.scanForConflicts(tenantId);
      const fullScanPayload = (
        mockConflictModel.insertMany as jest.Mock<Promise<unknown[]>, [unknown[]]>
      ).mock.calls[0][0];

      jest.resetAllMocks();
      mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);
      await service.scanForConflicts(tenantId, [factKey]);
      const incrementalPayload = (
        mockConflictModel.insertMany as jest.Mock<Promise<unknown[]>, [unknown[]]>
      ).mock.calls[0][0];

      expect(incrementalPayload).toEqual(fullScanPayload);
    });
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
    it('should page conflicts for the default tenant, batch-load their facts in one $in query, and record an audit event scoped to the actor', async () => {
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
      const documentVersionIdA = new Types.ObjectId();
      const documentVersionIdB = new Types.ObjectId();
      const factA = {
        _id: factIdA,
        value: { amount: 5.25, unit: 'percent' },
        chunkId: 'chunk-xlsx',
        documentVersionId: documentVersionIdA,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      };
      const factB = {
        _id: factIdB,
        value: { amount: 6.1, unit: 'percent' },
        chunkId: 'chunk-prose',
        documentVersionId: documentVersionIdB,
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
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
      expect(mockExtractedFactModel.find).toHaveBeenCalledTimes(1);
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        _id: { $in: [factIdA, factIdB] },
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
            values: [
              {
                factId: factIdA.toString(),
                value: 5.25,
                unit: 'percent',
                sourceChunkId: 'chunk-xlsx',
                documentVersionId: documentVersionIdA.toString(),
                locator: factA.locator,
              },
              {
                factId: factIdB.toString(),
                value: 6.1,
                unit: 'percent',
                sourceChunkId: 'chunk-prose',
                documentVersionId: documentVersionIdB.toString(),
                locator: factB.locator,
              },
            ],
            magnitude: 0.0085,
            status: 'open',
            createdAt: conflict.createdAt,
          },
        ],
        count: 1,
      });
    });

    it('should scope the query to an explicit tenantId and skip the fact query entirely for an empty page', async () => {
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
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
      expect(result).toEqual({ docs: [], count: 0 });
    });

    it('should throw InternalServerErrorException when a listed conflict references a fact that no longer resolves', async () => {
      const actorId = new Types.ObjectId().toString();
      const factIdA = new Types.ObjectId();
      const missingFactId = new Types.ObjectId();
      const conflict = {
        _id: new Types.ObjectId(),
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        factIds: [factIdA, missingFactId],
        magnitude: 0.0085,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        {
          _id: factIdA,
          value: { amount: 5.25, unit: 'percent' },
          chunkId: 'chunk-xlsx',
          documentVersionId: new Types.ObjectId(),
          locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
        },
      ]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      let caught: unknown;
      try {
        await service.list({ skip: 0, limit: 20 }, actorId);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InternalServerErrorException);
      expect((caught as Error).message).toMatch(/references 2 fact\(s\), but only 1/);
    });
  });

  describe('loadConflictForResolution', () => {
    const conflictId = new Types.ObjectId().toString();
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };

    it('should throw ConflictNotFoundException without querying when conflictId is not a valid ObjectId', async () => {
      await expect(
        service.loadConflictForResolution(
          'not-an-id',
          new Types.ObjectId().toString(),
          'acme-corp',
        ),
      ).rejects.toThrow(ConflictNotFoundException);
      expect(mockConflictModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw ConflictNotFoundException when no conflict matches the tenant-scoped id', async () => {
      mockConflictModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.loadConflictForResolution(conflictId, new Types.ObjectId().toString(), 'acme-corp'),
      ).rejects.toThrow(ConflictNotFoundException);
      expect(mockConflictModel.findOne).toHaveBeenCalledWith({
        _id: conflictId,
        tenantId: 'acme-corp',
      });
    });

    it('should throw InvalidConflictResolutionException when the conflict is not open', async () => {
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        status: 'resolved',
      });

      await expect(
        service.loadConflictForResolution(conflictId, new Types.ObjectId().toString(), 'acme-corp'),
      ).rejects.toThrow(InvalidConflictResolutionException);
    });

    it('should throw InvalidConflictResolutionException when winningFactId is not a valid ObjectId', async () => {
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        status: 'open',
      });

      await expect(
        service.loadConflictForResolution(conflictId, 'not-an-id', 'acme-corp'),
      ).rejects.toThrow(InvalidConflictResolutionException);
    });

    it("should throw InvalidConflictResolutionException when winningFactId is not one of the conflict's factIds", async () => {
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        status: 'open',
      });

      await expect(
        service.loadConflictForResolution(conflictId, new Types.ObjectId().toString(), 'acme-corp'),
      ).rejects.toThrow(InvalidConflictResolutionException);
    });

    it('should throw InternalServerErrorException when a factId no longer resolves to an ExtractedFact', async () => {
      const factIdA = new Types.ObjectId();
      const factIdB = new Types.ObjectId();
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [factIdA, factIdB],
        status: 'open',
      });
      mockExtractedFactModel.find.mockResolvedValueOnce([
        { _id: factIdA, value: { amount: 5.25, unit: 'percent' }, chunkId: 'chunk-a' },
      ]);

      await expect(
        service.loadConflictForResolution(conflictId, factIdA.toString(), 'acme-corp'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should default tenantId to the shared tenant constant and return the resolution candidate for a valid, open conflict', async () => {
      const factIdA = new Types.ObjectId();
      const factIdB = new Types.ObjectId();
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [factIdA, factIdB],
        status: 'open',
      });
      mockExtractedFactModel.find.mockResolvedValueOnce([
        { _id: factIdA, value: { amount: 5.25, unit: 'percent' }, chunkId: 'chunk-xlsx' },
        { _id: factIdB, value: { amount: 6.1, unit: 'percent' }, chunkId: 'chunk-prose' },
      ]);

      const result = await service.loadConflictForResolution(conflictId, factIdA.toString());

      expect(mockConflictModel.findOne).toHaveBeenCalledWith({
        _id: conflictId,
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        _id: { $in: [factIdA, factIdB] },
      });
      expect(result).toEqual({
        conflictId,
        factKey,
        winningFactId: factIdA.toString(),
        values: [
          { factId: factIdA.toString(), value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
          { factId: factIdB.toString(), value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
        ],
      });
    });
  });

  describe('requestResolution', () => {
    const conflictId = new Types.ObjectId().toString();
    const winningFactId = new Types.ObjectId().toString();
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const actorId = new Types.ObjectId().toString();

    const stubOpenConflict = () => {
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [new Types.ObjectId(winningFactId), new Types.ObjectId()],
        status: 'open',
      });
      mockExtractedFactModel.find.mockResolvedValueOnce([
        {
          _id: new Types.ObjectId(winningFactId),
          value: { amount: 5.25, unit: 'percent' },
          chunkId: 'chunk-xlsx',
        },
        {
          _id: new Types.ObjectId(),
          value: { amount: 6.1, unit: 'percent' },
          chunkId: 'chunk-prose',
        },
      ]);
    };

    it('should start the resolveConflict workflow, record the run, and audit — defaulting tenantId', async () => {
      stubOpenConflict();
      mockWorkflowEngine.start.mockResolvedValueOnce({ id: 'wf-1', status: 'running' });
      const run = {
        id: 'run-1',
        workflowId: 'wf-1',
        status: 'running',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockWorkflowRunsService.create.mockResolvedValueOnce(run);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.requestResolution({
        conflictId,
        winningFactId,
        actorId,
        requestedBy: 'analyst@example.com',
      });

      expect(mockWorkflowEngine.start).toHaveBeenCalledWith('resolveConflict', {
        conflictId,
        winningFactId,
        requestedBy: 'analyst@example.com',
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(mockWorkflowRunsService.create).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        status: 'running',
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'conflicts.resolution_requested',
        actorId,
        subject: { entityType: 'Conflict', entityId: conflictId },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result).toEqual(run);
    });

    it('should scope the workflow start and the run to an explicit tenantId when provided', async () => {
      stubOpenConflict();
      mockWorkflowEngine.start.mockResolvedValueOnce({ id: 'wf-2', status: 'running' });
      mockWorkflowRunsService.create.mockResolvedValueOnce({
        id: 'run-2',
        workflowId: 'wf-2',
        status: 'running',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });

      await service.requestResolution({
        conflictId,
        winningFactId,
        actorId,
        requestedBy: 'analyst@example.com',
        tenantId: 'acme-corp',
      });

      expect(mockWorkflowEngine.start).toHaveBeenCalledWith(
        'resolveConflict',
        expect.objectContaining({ tenantId: 'acme-corp' }),
      );
      expect(mockWorkflowRunsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'acme-corp' }),
      );
    });

    it("should propagate loadConflictForResolution's validation failure without starting a workflow", async () => {
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [new Types.ObjectId(winningFactId), new Types.ObjectId()],
        status: 'resolved',
      });

      await expect(
        service.requestResolution({
          conflictId,
          winningFactId,
          actorId,
          requestedBy: 'analyst@example.com',
        }),
      ).rejects.toThrow(InvalidConflictResolutionException);
      expect(mockWorkflowEngine.start).not.toHaveBeenCalled();
      expect(mockWorkflowRunsService.create).not.toHaveBeenCalled();
    });
  });

  describe('recordResolution', () => {
    const conflictId = new Types.ObjectId().toString();

    // Typed explicitly (not inferred from a `resolution: undefined` initializer, which would
    // narrow the field's type to the literal `undefined`) so `conflict.resolution?.resolvedAt`
    // below type-checks after the service mutates it in place.
    interface MockConflictDoc {
      status: string;
      resolution?: {
        outcome: string;
        winningFactId?: Types.ObjectId;
        decidedBy?: string;
        reason?: string;
        resolvedAt: Date;
      };
      save: jest.Mock;
    }

    it('should throw ConflictNotFoundException without querying when conflictId is not a valid ObjectId', async () => {
      await expect(
        service.recordResolution({ conflictId: 'not-an-id', outcome: 'timed_out' }),
      ).rejects.toThrow(ConflictNotFoundException);
      expect(mockConflictModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw ConflictNotFoundException, defaulting tenantId, when no conflict matches', async () => {
      mockConflictModel.findOne.mockResolvedValueOnce(null);

      await expect(service.recordResolution({ conflictId, outcome: 'timed_out' })).rejects.toThrow(
        ConflictNotFoundException,
      );
      expect(mockConflictModel.findOne).toHaveBeenCalledWith({
        _id: conflictId,
        tenantId: DEFAULT_TENANT_ID,
      });
    });

    it('should record an approved resolution, set the winner, and flip status to resolved', async () => {
      const winningFactId = new Types.ObjectId().toString();
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = { status: 'open', resolution: undefined, save: mockSave };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      const result = await service.recordResolution({
        conflictId,
        outcome: 'resolved',
        winningFactId,
        decidedBy: 'reviewer@example.com',
        reason: 'Spreadsheet is the current underwriting figure.',
        tenantId: 'acme-corp',
      });

      expect(mockConflictModel.findOne).toHaveBeenCalledWith({
        _id: conflictId,
        tenantId: 'acme-corp',
      });
      expect(conflict.status).toBe('resolved');
      // `resolvedAt` asserted separately, not via `expect.any(Date)` inside the object literal —
      // `expect.any(...)`'s `any`-typed return trips `no-unsafe-assignment` wherever it lands
      // inside an object (same reasoning `ingestion.service.spec.ts` documents for its own
      // `getFindOneAndUpdateCall` helper).
      expect(conflict.resolution?.resolvedAt).toBeInstanceOf(Date);
      expect(conflict.resolution).toMatchObject({
        outcome: 'resolved',
        winningFactId: new Types.ObjectId(winningFactId),
        decidedBy: 'reviewer@example.com',
        reason: 'Spreadsheet is the current underwriting figure.',
      });
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ conflictId, outcome: 'resolved' });
    });

    it('should record a rejected resolution with no winner and leave status untouched', async () => {
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = { status: 'open', resolution: undefined, save: mockSave };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      const result = await service.recordResolution({
        conflictId,
        outcome: 'rejected',
        decidedBy: 'reviewer@example.com',
        reason: 'Not enough context to confirm.',
        tenantId: 'acme-corp',
      });

      expect(conflict.status).toBe('open');
      expect(conflict.resolution?.resolvedAt).toBeInstanceOf(Date);
      expect(conflict.resolution).toMatchObject({
        outcome: 'rejected',
        winningFactId: undefined,
        decidedBy: 'reviewer@example.com',
        reason: 'Not enough context to confirm.',
      });
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ conflictId, outcome: 'rejected' });
    });
  });
});
