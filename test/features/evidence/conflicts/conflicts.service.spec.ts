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
        { provide: AppLogger, useValue: getMockLogger() },
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
    expect(result).toEqual({ conflictsCreated: 0 });
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
    expect(result).toEqual({ conflictsCreated: 0 });
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
    expect(result).toEqual({ conflictsCreated: 1 });
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
    expect(result).toEqual({ conflictsCreated: 0 });
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
