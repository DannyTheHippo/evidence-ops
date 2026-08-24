import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type {
  MetricDefinition,
  MetricPackData,
} from '../../../../src/database/schemas/evidence/metric-pack/metric-pack.schema';
import { Approval } from '../../../../src/database/schemas/workflow/approval/approval.schema';
import { ConflictsService } from '../../../../src/features/evidence/conflicts/conflicts.service';
import {
  ConflictNotFoundException,
  ConflictResolutionAlreadyPendingException,
  InvalidConflictResolutionException,
} from '../../../../src/features/evidence/conflicts/exceptions/conflicts.exception';
import * as resolveConflictPolicyModule from '../../../../src/features/evidence/conflicts/resolve-conflict-policy';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { MetricPacksService } from '../../../../src/features/evidence/facts/metric-packs.service';
import { MetricPoliciesService } from '../../../../src/features/evidence/facts/metric-policies.service';
import { CRE_PACK_V1 } from '../../../../src/features/evidence/facts/packs/cre.pack';
import { WorkflowRunsService } from '../../../../src/features/evidence/workflow-runs/workflow-runs.service';
import { approvalTimeoutCounter } from '../../../../src/providers/telemetry/domain-metrics';
import { WORKFLOW_ENGINE } from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('ConflictsService', () => {
  let service: ConflictsService;

  const mockExtractedFactModel = getMockModel();
  const mockConflictModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
  const mockDocumentModel = getMockModel();
  const mockApprovalModel = getMockModel();
  const mockWorkflowEngine = { start: jest.fn(), status: jest.fn(), signal: jest.fn() };
  const mockWorkflowRunsService = { create: jest.fn(), findById: jest.fn() };
  const mockMetricPoliciesService = { resolveForTenant: jest.fn() };
  const mockMetricPacksService = {
    resolveActive: jest.fn(),
    findVersion: jest.fn(),
  } satisfies Record<keyof Pick<MetricPacksService, 'resolveActive' | 'findVersion'>, jest.Mock>;
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  // The byte-identical-to-today policy every existing test below assumes: no tenant has authored
  // an override, so this is exactly the fold `MetricPoliciesService.resolveForTenant` produces
  // over `METRIC_ONTOLOGY` alone.
  const defaultPolicies = new Map(
    METRIC_ONTOLOGY.map((metric) => [
      metric.id,
      {
        authorityOrder: metric.authorityOrder,
        stalenessWindowMs: metric.stalenessWindowMs ?? Number.POSITIVE_INFINITY,
      },
    ]),
  );

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
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: getModelToken(Approval.name), useValue: mockApprovalModel },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: WorkflowRunsService, useValue: mockWorkflowRunsService },
        { provide: MetricPoliciesService, useValue: mockMetricPoliciesService },
        { provide: MetricPacksService, useValue: mockMetricPacksService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ConflictsService>(ConflictsService);
    // Re-set every `beforeEach`, not once at module scope — `afterEach`'s `resetAllMocks()` wipes
    // implementations, not just call history.
    mockMetricPoliciesService.resolveForTenant.mockResolvedValue(defaultPolicies);
    // The byte-identical-to-today pack every existing test below assumes: no tenant has authored
    // or activated a pack of its own, so every scan/list resolves to exactly the code default.
    mockMetricPacksService.resolveActive.mockResolvedValue(CRE_PACK_V1);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should full-scan via a cursor when factKeys is omitted', async () => {
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([]));

    const result = await service.scanForConflicts('acme-corp');

    expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
      { tenantId: 'acme-corp' },
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

    expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId });
    expect(mockConflictModel.insertMany).toHaveBeenCalledTimes(1);
    const insertManyMock = mockConflictModel.insertMany as jest.Mock<
      Promise<unknown[]>,
      [
        {
          factKey: { entity: string; metric: string; period: string };
          groupKeyNormalized: string;
          factIds: Types.ObjectId[];
          magnitude: number;
          magnitudeUnit: string;
          packId: string;
          packVersion: number;
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
    // cap_rate is a ratio metric — see the paired currency-metric assertion below, which is what
    // catches a magnitudeUnit backfill that blanket-assigns one unit to every conflict.
    expect(insertedConflicts[0].magnitudeUnit).toBe('ratio');
    expect(insertedConflicts[0].packId).toBe(CRE_PACK_V1.packId);
    expect(insertedConflicts[0].packVersion).toBe(CRE_PACK_V1.version);
    expect(insertedConflicts[0].status).toBe('open');
    expect(insertedConflicts[0].tenantId).toBe(tenantId);
    expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
  });

  it('should stamp magnitudeUnit with the currency metric’s canonical unit, not the ratio metric’s', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' };
    // 1% relative tolerance; $41.0M vs $42.5M is a 3.5%-of-larger-value spread past it.
    const factLow = buildFact(factKey, { amount: 41_000_000, unit: 'usd' });
    const factHigh = buildFact(factKey, { amount: 42_500_000, unit: 'usd' });
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
    mockConflictModel.find.mockResolvedValueOnce([]);
    mockConflictModel.insertMany.mockResolvedValueOnce([]);

    await service.scanForConflicts(tenantId);

    const insertManyMock = mockConflictModel.insertMany as jest.Mock<
      Promise<unknown[]>,
      [{ magnitudeUnit: string }[]]
    >;
    const insertedConflicts = insertManyMock.mock.calls[0][0];
    expect(insertedConflicts).toHaveLength(1);
    expect(insertedConflicts[0].magnitudeUnit).toBe('usd');
  });

  it('should skip a candidate whose group already has an open Conflict record', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
    const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
    mockConflictModel.find.mockResolvedValueOnce([{ factKey, status: 'open' }]);

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
      // `resetAllMocks()` wipes implementations, not just call history — re-arm the default pack
      // resolution the same way `beforeEach` does.
      mockMetricPacksService.resolveActive.mockResolvedValue(CRE_PACK_V1);
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

  describe('idempotency against resolved/dismissed conflicts', () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };

    it.each(['resolved', 'dismissed'] as const)(
      "should not resurrect a %s conflict when the group's factIds are unchanged",
      async (status) => {
        const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
        const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
        mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
        mockConflictModel.find.mockResolvedValueOnce([
          { factKey, status, factIds: [factLow._id, factHigh._id] },
        ]);

        const result = await service.scanForConflicts(tenantId);

        expect(mockConflictModel.insertMany).not.toHaveBeenCalled();
        expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
      },
    );

    it('should create a fresh conflict when the group grew with a new fact, even though a resolved conflict already exists for the old evidence', async () => {
      const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
      const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
      const factNew = buildFact(factKey, { amount: 6.5, unit: 'percent' });
      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh, factNew]));
      mockConflictModel.find.mockResolvedValueOnce([
        { factKey, status: 'resolved', factIds: [factLow._id, factHigh._id] },
      ]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.scanForConflicts(tenantId);

      expect(mockConflictModel.insertMany).toHaveBeenCalledTimes(1);
      const insertedConflicts = (
        mockConflictModel.insertMany as jest.Mock<
          Promise<unknown[]>,
          [{ factIds: Types.ObjectId[] }[]]
        >
      ).mock.calls[0][0];
      expect(insertedConflicts[0].factIds.map((id) => id.toString())).toEqual(
        [factLow._id, factHigh._id, factNew._id].map((id) => id.toString()),
      );
      expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
    });
  });

  describe('scanForConflictsByMetrics', () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const groupKeyNormalized = 'northgate business park::cap_rate::2025-03';

    it('should resolve metricIds to their groupKeyNormalized values via distinct, then scan only those groups', async () => {
      const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
      const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
      mockExtractedFactModel.distinct.mockResolvedValueOnce([groupKeyNormalized]);
      mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.scanForConflictsByMetrics(tenantId, ['cap_rate']);

      expect(mockExtractedFactModel.distinct).toHaveBeenCalledWith('groupKeyNormalized', {
        tenantId,
        'factKey.metric': { $in: ['cap_rate'] },
      });
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId, groupKeyNormalized: { $in: [groupKeyNormalized] } },
        { factKey: 1, value: 1 },
      );
      expect(mockConflictModel.find).toHaveBeenCalledWith({
        tenantId,
        groupKeyNormalized: { $in: [groupKeyNormalized] },
      });
      expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
    });

    it('should rescan nothing when metricIds is empty — a pack version that only renamed labels or added aliases', async () => {
      mockExtractedFactModel.distinct.mockResolvedValueOnce([]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      const result = await service.scanForConflictsByMetrics(tenantId, []);

      expect(mockExtractedFactModel.distinct).toHaveBeenCalledWith('groupKeyNormalized', {
        tenantId,
        'factKey.metric': { $in: [] },
      });
      expect(mockConflictModel.find).not.toHaveBeenCalled();
      expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
    });
  });

  describe('retractConflicts', () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const groupKeyNormalized = 'northgate business park::cap_rate::2025-03';

    it('should return conflictsRetracted 0 without querying when metricIds is empty', async () => {
      const result = await service.retractConflicts(tenantId, []);

      expect(mockConflictModel.find).not.toHaveBeenCalled();
      expect(result).toEqual({ conflictsRetracted: 0 });
    });

    it('should return conflictsRetracted 0 without further queries when no open conflict matches the given metrics', async () => {
      mockConflictModel.find.mockResolvedValueOnce([]);

      const result = await service.retractConflicts(tenantId, ['cap_rate']);

      expect(mockConflictModel.find).toHaveBeenCalledWith({
        tenantId,
        status: 'open',
        'factKey.metric': { $in: ['cap_rate'] },
      });
      expect(mockApprovalModel.find).not.toHaveBeenCalled();
      expect(result).toEqual({ conflictsRetracted: 0 });
    });

    it('should dismiss an open conflict as retracted, stamped with the active pack, when its current group no longer conflicts', async () => {
      const conflictId = new Types.ObjectId();
      const openConflict = { _id: conflictId, factKey, groupKeyNormalized, status: 'open' };
      // 5.25% vs 5.30% is a 5bp spread — well inside cap_rate's 25bp absolute tolerance, so the
      // group the conflict once disagreed over no longer does.
      const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
      const factHigh = buildFact(factKey, { amount: 5.3, unit: 'percent' });
      mockConflictModel.find.mockResolvedValueOnce([openConflict]);
      mockApprovalModel.find.mockResolvedValueOnce([]);
      mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);
      mockConflictModel.updateMany.mockResolvedValueOnce({});

      const result = await service.retractConflicts(tenantId, ['cap_rate']);

      expect(mockApprovalModel.find).toHaveBeenCalledWith(
        {
          tenantId,
          state: 'pending',
          'subject.entityType': 'Conflict',
          'subject.entityId': { $in: [conflictId] },
        },
        { 'subject.entityId': 1 },
      );
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId, groupKeyNormalized: { $in: [groupKeyNormalized] } },
        { factKey: 1, value: 1 },
      );
      expect(mockConflictModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [conflictId] } },
        {
          status: 'dismissed',
          resolution: {
            outcome: 'retracted',
            resolvedAt: expect.any(Date) as Date,
            packId: CRE_PACK_V1.packId,
            packVersion: CRE_PACK_V1.version,
          },
        },
      );
      expect(result).toEqual({ conflictsRetracted: 1 });
    });

    it('should not retract an open conflict whose current group still conflicts under the active pack', async () => {
      const conflictId = new Types.ObjectId();
      const openConflict = { _id: conflictId, factKey, groupKeyNormalized, status: 'open' };
      const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
      const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
      mockConflictModel.find.mockResolvedValueOnce([openConflict]);
      mockApprovalModel.find.mockResolvedValueOnce([]);
      mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);

      const result = await service.retractConflicts(tenantId, ['cap_rate']);

      expect(mockConflictModel.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ conflictsRetracted: 0 });
    });

    it('should skip retracting a conflict that carries a pending resolution approval', async () => {
      const conflictId = new Types.ObjectId();
      const openConflict = { _id: conflictId, factKey, groupKeyNormalized, status: 'open' };
      const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
      const factHigh = buildFact(factKey, { amount: 5.3, unit: 'percent' });
      mockConflictModel.find.mockResolvedValueOnce([openConflict]);
      mockApprovalModel.find.mockResolvedValueOnce([
        { subject: { entityId: conflictId, entityType: 'Conflict' } },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);

      const result = await service.retractConflicts(tenantId, ['cap_rate']);

      expect(mockConflictModel.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ conflictsRetracted: 0 });
    });
  });

  describe('previewPackActivation', () => {
    const tenantId = 'acme-corp';

    const capRateMetric: MetricDefinition = {
      id: 'cap_rate',
      label: 'Cap Rate',
      aliases: ['Cap Rate'],
      valueType: 'percentage',
      canonicalUnit: 'ratio',
      units: [
        { id: 'ratio', toCanonicalFactor: 1 },
        { id: 'percent', toCanonicalFactor: 0.01 },
      ],
      toleranceKind: 'absolute',
      tolerance: 0.0025,
    };
    const salePriceMetric: MetricDefinition = {
      id: 'sale_price',
      label: 'Sale Price',
      aliases: ['Sale Price'],
      valueType: 'currency',
      canonicalUnit: 'usd',
      units: [
        { id: 'usd', toCanonicalFactor: 1 },
        { id: 'usd_thousands', toCanonicalFactor: 1_000 },
      ],
      toleranceKind: 'relative',
      tolerance: 0.01,
    };
    const activePack: MetricPackData = {
      packId: 'cre',
      version: 1,
      label: 'CRE Default',
      metrics: [capRateMetric, salePriceMetric],
    };

    it('should preview an empty metric set, querying nothing further, when the draft only relabels a metric', async () => {
      const draftPack: MetricPackData = {
        packId: 'cre-fork',
        version: 2,
        label: 'CRE Fork',
        metrics: [{ ...capRateMetric, label: 'Capitalization Rate' }, salePriceMetric],
      };
      mockMetricPacksService.findVersion.mockResolvedValueOnce(draftPack);
      mockMetricPacksService.resolveActive.mockResolvedValueOnce(activePack);

      const result = await service.previewPackActivation(tenantId, 'cre-fork', 2);

      expect(result).toEqual({ metrics: [] });
      expect(mockExtractedFactModel.distinct).not.toHaveBeenCalled();
      expect(mockConflictModel.find).not.toHaveBeenCalled();
    });

    it('should skip the existing-conflicts query when no candidate conflicts under the draft pack at all', async () => {
      const draftPack: MetricPackData = {
        packId: 'cre-fork',
        version: 2,
        label: 'CRE Fork',
        metrics: [{ ...capRateMetric, tolerance: 0.5 }, salePriceMetric],
      };
      mockMetricPacksService.findVersion.mockResolvedValueOnce(draftPack);
      mockMetricPacksService.resolveActive.mockResolvedValueOnce(activePack);
      mockExtractedFactModel.distinct.mockResolvedValueOnce([]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockConflictModel.find.mockResolvedValueOnce([]); // would-retract's own openConflicts query

      const result = await service.previewPackActivation(tenantId, 'cre-fork', 2);

      expect(result).toEqual({ metrics: [] });
      // The would-create half bails out before ever reading existing conflicts — the only
      // `conflictModel.find` call below is would-retract's `openConflicts` query.
      expect(mockConflictModel.find).toHaveBeenCalledTimes(1);
      expect(mockConflictModel.find).toHaveBeenCalledWith({
        tenantId,
        status: 'open',
        'factKey.metric': { $in: ['cap_rate'] },
      });
    });

    it('should report per-metric would-create/would-retract counts without writing anything to Mongo', async () => {
      const capRateFactKey = {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: '2025-03',
      };
      const capRateGroupKeyNormalized = 'northgate business park::cap_rate::2025-03';
      const salePriceFactKey = {
        entity: 'Fenwick Logistics Center',
        metric: 'sale_price',
        period: '2025-02',
      };
      const salePriceGroupKeyNormalized = 'fenwick logistics center::sale_price::2025-02';

      const draftPack: MetricPackData = {
        packId: 'cre-fork',
        version: 2,
        label: 'CRE Fork',
        metrics: [
          // Loosened: the tenant's existing open cap_rate conflict would no longer disagree.
          { ...capRateMetric, tolerance: 0.5 },
          // Tightened: facts that agree under the active pack's 1% relative tolerance would newly
          // disagree under the draft's 0.1%.
          { ...salePriceMetric, tolerance: 0.001 },
        ],
      };
      mockMetricPacksService.findVersion.mockResolvedValueOnce(draftPack);
      mockMetricPacksService.resolveActive.mockResolvedValueOnce(activePack);

      const capRateFactLow = buildFact(capRateFactKey, { amount: 5.25, unit: 'percent' });
      const capRateFactHigh = buildFact(capRateFactKey, { amount: 6.1, unit: 'percent' });
      const salePriceFactA = buildFact(salePriceFactKey, { amount: 1_000_000, unit: 'usd' });
      const salePriceFactB = buildFact(salePriceFactKey, { amount: 1_005_000, unit: 'usd' });

      // would-create half: `previewWouldCreate`'s own query shape.
      mockExtractedFactModel.distinct.mockResolvedValueOnce([
        capRateGroupKeyNormalized,
        salePriceGroupKeyNormalized,
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        capRateFactLow,
        capRateFactHigh,
        salePriceFactA,
        salePriceFactB,
      ]);
      mockConflictModel.find.mockResolvedValueOnce([]); // no existing conflict for either group

      // would-retract half: `findRetractableConflicts`'s own query shape.
      const openCapRateConflictId = new Types.ObjectId();
      mockConflictModel.find.mockResolvedValueOnce([
        {
          _id: openCapRateConflictId,
          factKey: capRateFactKey,
          groupKeyNormalized: capRateGroupKeyNormalized,
          status: 'open',
        },
      ]);
      mockApprovalModel.find.mockResolvedValueOnce([]);
      mockExtractedFactModel.find.mockResolvedValueOnce([capRateFactLow, capRateFactHigh]);

      const result = await service.previewPackActivation(tenantId, 'cre-fork', 2);

      expect(mockExtractedFactModel.distinct).toHaveBeenCalledWith('groupKeyNormalized', {
        tenantId,
        'factKey.metric': { $in: ['cap_rate', 'sale_price'] },
      });
      expect(mockConflictModel.find).toHaveBeenNthCalledWith(1, {
        tenantId,
        groupKeyNormalized: { $in: [capRateGroupKeyNormalized, salePriceGroupKeyNormalized] },
      });
      expect(mockConflictModel.find).toHaveBeenNthCalledWith(2, {
        tenantId,
        status: 'open',
        'factKey.metric': { $in: ['cap_rate', 'sale_price'] },
      });
      expect(result).toEqual({
        metrics: [
          { metricId: 'cap_rate', wouldCreate: 0, wouldRetract: 1 },
          { metricId: 'sale_price', wouldCreate: 1, wouldRetract: 0 },
        ],
      });
      // The whole point of a preview: it computes the same thing an activation's rescan would, but
      // commits none of it.
      expect(mockConflictModel.insertMany).not.toHaveBeenCalled();
      expect(mockConflictModel.updateMany).not.toHaveBeenCalled();
      expect(mockExtractedFactModel.updateMany).not.toHaveBeenCalled();
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
    it('should page conflicts for a tenant, batch-load their facts in one $in query, and record an audit event scoped to the actor', async () => {
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
        packId: CRE_PACK_V1.packId,
        packVersion: CRE_PACK_V1.version,
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
      // Neither fact's `documentVersionId` resolves — `cap_rate` has no `authorityOrder`
      // regardless, so the proposal is `'none'` either way, but this also exercises
      // `loadFactSourceEnrichment`'s "no matching versions" branch (`documentIds.length === 0`,
      // never calling `documentModel.find`).
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockConflictModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
      });
      expect(mockExtractedFactModel.find).toHaveBeenCalledTimes(1);
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        _id: { $in: [factIdA, factIdB] },
        tenantId: 'tenant-a',
      });
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        { _id: { $in: [documentVersionIdA, documentVersionIdB] }, tenantId: 'tenant-a' },
        { documentId: 1, withdrawnAt: 1 },
      );
      expect(mockDocumentModel.find).not.toHaveBeenCalled();
      expect(mockMetricPoliciesService.resolveForTenant).toHaveBeenCalledTimes(1);
      expect(mockMetricPoliciesService.resolveForTenant).toHaveBeenCalledWith('tenant-a');
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'conflicts.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
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
                withdrawn: false,
              },
              {
                factId: factIdB.toString(),
                value: 6.1,
                unit: 'percent',
                sourceChunkId: 'chunk-prose',
                documentVersionId: documentVersionIdB.toString(),
                locator: factB.locator,
                withdrawn: false,
              },
            ],
            magnitude: 0.0085,
            status: 'open',
            createdAt: conflict.createdAt,
            stale: false,
            unscorable: false,
            ruleFired: 'none',
            explanation: 'No authorityOrder is configured for this metric.',
          },
        ],
        count: 1,
      });
    });

    it("should mark a conflict stale, with a reason naming both packs, when its stamped packId/packVersion no longer match the tenant's active pack", async () => {
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
        // Detected under an earlier pack version than the tenant's current active one.
        packId: CRE_PACK_V1.packId,
        packVersion: CRE_PACK_V1.version + 1,
      };
      const factA = {
        _id: factIdA,
        value: { amount: 5.25, unit: 'percent' },
        chunkId: 'chunk-xlsx',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      };
      const factB = {
        _id: factIdB,
        value: { amount: 6.1, unit: 'percent' },
        chunkId: 'chunk-prose',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(result.docs[0].stale).toBe(true);
      expect(result.docs[0].staleReason).toContain(
        `${CRE_PACK_V1.packId}' v${CRE_PACK_V1.version + 1}`,
      );
      expect(result.docs[0].staleReason).toContain(
        `${CRE_PACK_V1.packId}' v${CRE_PACK_V1.version}`,
      );
      // Staleness is independent of unscorability — this row's evidence is fully intact.
      expect(result.docs[0].unscorable).toBe(false);
    });

    it('should resolve the tenant survivorship-policy map once for a page of multiple conflicts, not once per conflict', async () => {
      const actorId = new Types.ObjectId().toString();
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      const conflictOne = {
        _id: new Types.ObjectId(),
        factKey,
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        magnitude: 0.0085,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      const conflictTwo = {
        _id: new Types.ObjectId(),
        factKey,
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        magnitude: 0.009,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      const buildResolvedFact = (id: Types.ObjectId, amount: number) => ({
        _id: id,
        value: { amount, unit: 'percent' },
        chunkId: `chunk-${id.toString()}`,
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'A1' },
      });
      const facts = [
        ...conflictOne.factIds.map((id, index) => buildResolvedFact(id, 5.25 + index)),
        ...conflictTwo.factIds.map((id, index) => buildResolvedFact(id, 6.1 + index)),
      ];
      mockConflictModel.find.mockResolvedValueOnce([conflictOne, conflictTwo]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(2);
      mockExtractedFactModel.find.mockResolvedValueOnce(facts);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(mockMetricPoliciesService.resolveForTenant).toHaveBeenCalledTimes(1);
      expect(mockMetricPoliciesService.resolveForTenant).toHaveBeenCalledWith('tenant-a');
      expect(result.docs).toHaveLength(2);
    });

    it("should propose the higher-authority fact, keyed by each document version's sourceClass, for a metric with an authorityOrder", async () => {
      const actorId = new Types.ObjectId().toString();
      const factIdPm = new Types.ObjectId();
      const factIdSpreadsheet = new Types.ObjectId();
      const conflict = {
        _id: new Types.ObjectId(),
        factKey: {
          entity: 'Northgate Business Park',
          metric: 'net_operating_income',
          period: '2025-03',
        },
        factIds: [factIdPm, factIdSpreadsheet],
        magnitude: 50000,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      const documentVersionIdPm = new Types.ObjectId();
      const documentVersionIdSpreadsheet = new Types.ObjectId();
      const documentIdPm = new Types.ObjectId();
      const documentIdSpreadsheet = new Types.ObjectId();
      const factPm = {
        _id: factIdPm,
        value: { amount: 500000, unit: 'usd' },
        chunkId: 'chunk-pm',
        documentVersionId: documentVersionIdPm,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Rent Roll', cell: 'B2' },
        observedAt: undefined,
      };
      const factSpreadsheet = {
        _id: factIdSpreadsheet,
        value: { amount: 550000, unit: 'usd' },
        chunkId: 'chunk-comps',
        documentVersionId: documentVersionIdSpreadsheet,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'C4' },
        observedAt: undefined,
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([factPm, factSpreadsheet]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        { _id: documentVersionIdPm, documentId: documentIdPm },
        { _id: documentVersionIdSpreadsheet, documentId: documentIdSpreadsheet },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentIdPm, sourceClass: 'pm-export' },
        { _id: documentIdSpreadsheet, sourceClass: 'spreadsheet' },
      ]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(mockDocumentModel.find).toHaveBeenCalledWith(
        { _id: { $in: [documentIdPm, documentIdSpreadsheet] }, tenantId: 'tenant-a' },
        { sourceClass: 1 },
      );
      expect(result.docs[0]).toMatchObject({
        proposedWinnerFactId: factIdPm.toString(),
        ruleFired: 'authority',
      });
      expect(result.docs[0].explanation).toContain(factIdPm.toString());
    });

    it('should mark a value withdrawn when its documentVersionId carries withdrawnAt, and leave the other value in the pair untouched', async () => {
      const actorId = new Types.ObjectId().toString();
      const factIdWithdrawn = new Types.ObjectId();
      const factIdLive = new Types.ObjectId();
      const conflict = {
        _id: new Types.ObjectId(),
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        factIds: [factIdWithdrawn, factIdLive],
        magnitude: 0.0085,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      const documentVersionIdWithdrawn = new Types.ObjectId();
      const documentVersionIdLive = new Types.ObjectId();
      const factWithdrawn = {
        _id: factIdWithdrawn,
        value: { amount: 5.25, unit: 'percent' },
        chunkId: 'chunk-withdrawn',
        documentVersionId: documentVersionIdWithdrawn,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      };
      const factLive = {
        _id: factIdLive,
        value: { amount: 6.1, unit: 'percent' },
        chunkId: 'chunk-live',
        documentVersionId: documentVersionIdLive,
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      };
      const documentIdWithdrawn = new Types.ObjectId();
      const documentIdLive = new Types.ObjectId();
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([factWithdrawn, factLive]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        {
          _id: documentVersionIdWithdrawn,
          documentId: documentIdWithdrawn,
          withdrawnAt: new Date('2026-07-15T00:00:00.000Z'),
        },
        { _id: documentVersionIdLive, documentId: documentIdLive },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(result.docs[0].values).toEqual([
        expect.objectContaining({ factId: factIdWithdrawn.toString(), withdrawn: true }),
        expect.objectContaining({ factId: factIdLive.toString(), withdrawn: false }),
      ]);
      // Withdrawal is display-only — the conflict stays open and untouched by it.
      expect(result.docs[0].status).toBe('open');
      expect(result.docs[0].factIds).toEqual([factIdWithdrawn.toString(), factIdLive.toString()]);
    });

    it("should default a fact's sourceClass to unclassified when its document version, or that version's document, cannot be resolved", async () => {
      const actorId = new Types.ObjectId().toString();
      const factIdDanglingVersion = new Types.ObjectId();
      const factIdDanglingDocument = new Types.ObjectId();
      const conflict = {
        _id: new Types.ObjectId(),
        factKey: {
          entity: 'Northgate Business Park',
          metric: 'building_area_sf',
          period: '2025-03',
        },
        factIds: [factIdDanglingVersion, factIdDanglingDocument],
        magnitude: 500,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      const documentVersionIdDangling = new Types.ObjectId(); // never returned by documentVersionModel.find
      const documentVersionIdOrphanDocument = new Types.ObjectId();
      const documentIdOrphan = new Types.ObjectId(); // never returned by documentModel.find
      const factDanglingVersion = {
        _id: factIdDanglingVersion,
        value: { amount: 10000, unit: 'sf' },
        chunkId: 'chunk-a',
        documentVersionId: documentVersionIdDangling,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Sheet1', cell: 'A1' },
        observedAt: undefined,
      };
      const factDanglingDocument = {
        _id: factIdDanglingDocument,
        value: { amount: 10500, unit: 'sf' },
        chunkId: 'chunk-b',
        documentVersionId: documentVersionIdOrphanDocument,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Sheet1', cell: 'B1' },
        observedAt: undefined,
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        factDanglingVersion,
        factDanglingDocument,
      ]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        { _id: documentVersionIdOrphanDocument, documentId: documentIdOrphan },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      // `building_area_sf`'s `authorityOrder` never includes `'unclassified'`, so both facts
      // defaulting to it fails the policy closed to `'none'` — same as an explicit unclassified
      // document would.
      expect(result.docs[0]).toMatchObject({ ruleFired: 'none' });
      expect(result.docs[0].proposedWinnerFactId).toBeUndefined();
      expect(result.docs[0].explanation).toContain('unclassified');
    });

    it('should propose no winner, under a metric id absent from the ontology, without failing the read', async () => {
      const actorId = new Types.ObjectId().toString();
      const factIdA = new Types.ObjectId();
      const factIdB = new Types.ObjectId();
      const conflict = {
        _id: new Types.ObjectId(),
        factKey: {
          entity: 'Northgate Business Park',
          metric: 'unrecognized_metric',
          period: '2025-03',
        },
        factIds: [factIdA, factIdB],
        magnitude: 1,
        status: 'open',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      const documentVersionId = new Types.ObjectId();
      const factA = {
        _id: factIdA,
        value: { amount: 1, unit: 'sf' },
        chunkId: 'chunk-a',
        documentVersionId,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Sheet1', cell: 'A1' },
        observedAt: undefined,
      };
      const factB = {
        _id: factIdB,
        value: { amount: 2, unit: 'sf' },
        chunkId: 'chunk-b',
        documentVersionId,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Sheet1', cell: 'B1' },
        observedAt: undefined,
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(result.docs[0]).toMatchObject({ ruleFired: 'none' });
      expect(result.docs[0].explanation).toContain('No authorityOrder');
    });

    it('should scope the query to an explicit tenantId and skip the fact, document, and policy queries entirely for an empty page', async () => {
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
      expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
      expect(mockDocumentModel.find).not.toHaveBeenCalled();
      expect(mockMetricPoliciesService.resolveForTenant).not.toHaveBeenCalled();
      expect(result).toEqual({ docs: [], count: 0 });
    });

    it('should narrow both the find and countDocuments filter to the given status', async () => {
      const actorId = new Types.ObjectId().toString();
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.list({ skip: 0, limit: 20, status: 'resolved' }, actorId, 'acme-corp');

      expect(mockConflictModel.find).toHaveBeenCalledWith(
        { tenantId: 'acme-corp', status: 'resolved' },
        null,
        { sort: { createdAt: -1 }, skip: 0, limit: 20 },
      );
      expect(mockConflictModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'acme-corp',
        status: 'resolved',
      });
    });

    // Regression for the live 500: `DocumentsService.remove`'s conflict-shrink update only ever
    // touched `status: 'open'` conflicts while its fact deletes were not status-scoped at all, so
    // a `resolved`/`dismissed` conflict could end up with a `factIds` entry that no longer
    // resolves. `list` is a display path — it must degrade that one row, not 500 the whole page.
    it('should mark a listed conflict unscorable, rather than throw, when one of its factIds no longer resolves — and never compute a proposal for it', async () => {
      const actorId = new Types.ObjectId().toString();
      const factIdA = new Types.ObjectId();
      const missingFactId = new Types.ObjectId();
      const documentVersionIdA = new Types.ObjectId();
      const conflict = {
        _id: new Types.ObjectId(),
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        factIds: [factIdA, missingFactId],
        magnitude: 0.0085,
        status: 'resolved',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        packId: CRE_PACK_V1.packId,
        packVersion: CRE_PACK_V1.version,
      };
      const factA = {
        _id: factIdA,
        value: { amount: 5.25, unit: 'percent' },
        chunkId: 'chunk-xlsx',
        documentVersionId: documentVersionIdA,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockExtractedFactModel.find.mockResolvedValueOnce([factA]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockAuditService.record.mockResolvedValueOnce(undefined);
      const policySpy = jest.spyOn(resolveConflictPolicyModule, 'resolveConflictPolicy');

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(result.docs[0]).toEqual({
        id: conflict._id.toString(),
        factKey: conflict.factKey,
        factIds: [factIdA.toString(), missingFactId.toString()],
        values: [
          {
            factId: factIdA.toString(),
            value: 5.25,
            unit: 'percent',
            sourceChunkId: 'chunk-xlsx',
            documentVersionId: documentVersionIdA.toString(),
            locator: factA.locator,
            withdrawn: false,
          },
        ],
        magnitude: 0.0085,
        status: 'resolved',
        createdAt: conflict.createdAt,
        stale: false,
        unscorable: true,
        unscorableReason: '1 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
      });
      expect(policySpy).not.toHaveBeenCalled();
      policySpy.mockRestore();
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

    it('should return the resolution candidate for a valid, open conflict', async () => {
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

      const result = await service.loadConflictForResolution(
        conflictId,
        factIdA.toString(),
        'tenant-a',
      );

      expect(mockConflictModel.findOne).toHaveBeenCalledWith({
        _id: conflictId,
        tenantId: 'tenant-a',
      });
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        _id: { $in: [factIdA, factIdB] },
        tenantId: 'tenant-a',
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

    it('should normalize an uppercase-hex winningFactId to its canonical lowercase form', async () => {
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

      const uppercaseWinningFactId = factIdA.toString().toUpperCase();

      const result = await service.loadConflictForResolution(
        conflictId,
        uppercaseWinningFactId,
        'tenant-a',
      );

      expect(result.winningFactId).toBe(factIdA.toString());
      expect(result.values.find((value) => value.factId === result.winningFactId)).toBeDefined();
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
      // No pending `Approval` already sits on this conflict — the duplicate-guard check passes.
      mockApprovalModel.exists.mockResolvedValueOnce(null);
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
      // `computeProposalForConflict`'s own facts read (captured now, at request time, for
      // `ResolveConflictWorkflowInput`) — empty so `resolveConflictPolicy` sees fewer than two
      // candidates and settles on `ruleFired: 'none'` without touching sourceClass at all,
      // matching `cap_rate`'s own missing authorityOrder either way.
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
    };

    it('should start the resolveConflict workflow, record the run, and audit', async () => {
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
        origin: 'api',
        tenantId: 'tenant-a',
      });

      expect(mockApprovalModel.exists).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        state: 'pending',
        'subject.entityType': 'Conflict',
        'subject.entityId': new Types.ObjectId(conflictId),
      });
      expect(mockMetricPoliciesService.resolveForTenant).toHaveBeenCalledTimes(1);
      expect(mockMetricPoliciesService.resolveForTenant).toHaveBeenCalledWith('tenant-a');
      expect(mockWorkflowEngine.start).toHaveBeenCalledWith('resolveConflict', {
        conflictId,
        winningFactId,
        requestedBy: 'analyst@example.com',
        requestedByOrigin: 'api',
        tenantId: 'tenant-a',
        ruleFired: 'none',
        proposedWinnerFactId: undefined,
      });
      expect(mockWorkflowRunsService.create).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        workflowType: 'resolve-conflict',
        status: 'running',
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'conflicts.resolution_requested',
        actorId,
        subject: { entityType: 'Conflict', entityId: conflictId },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual(run);
    });

    it('should refuse when a pending approval already exists for the conflict, without starting a second workflow', async () => {
      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey,
        factIds: [new Types.ObjectId(winningFactId), new Types.ObjectId()],
        status: 'open',
      });
      // `loadConflictForResolution`'s own facts read — must resolve before the guard runs, since
      // the guard sits after that call, not before it.
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
      mockApprovalModel.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });

      await expect(
        service.requestResolution({
          conflictId,
          winningFactId,
          actorId,
          requestedBy: 'analyst@example.com',
          origin: 'api',
          tenantId: 'tenant-a',
        }),
      ).rejects.toThrow(ConflictResolutionAlreadyPendingException);
      expect(mockWorkflowEngine.start).not.toHaveBeenCalled();
      expect(mockWorkflowRunsService.create).not.toHaveBeenCalled();
      // The guard trips before the proposal is computed — no second `ExtractedFact.find` call
      // beyond `loadConflictForResolution`'s own, and no policy read paid for either.
      expect(mockExtractedFactModel.find).toHaveBeenCalledTimes(1);
      expect(mockMetricPoliciesService.resolveForTenant).not.toHaveBeenCalled();
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

    it('should capture an authority proposal from the current facts and thread it into the workflow input', async () => {
      const authorityFactKey = {
        entity: 'Northgate Business Park',
        metric: 'net_operating_income',
        period: '2025-03',
      };
      const factIdPm = new Types.ObjectId();
      const factIdSpreadsheet = new Types.ObjectId();
      const documentVersionIdPm = new Types.ObjectId();
      const documentVersionIdSpreadsheet = new Types.ObjectId();
      const documentIdPm = new Types.ObjectId();
      const documentIdSpreadsheet = new Types.ObjectId();

      mockConflictModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(conflictId),
        factKey: authorityFactKey,
        factIds: [factIdPm, factIdSpreadsheet],
        status: 'open',
      });
      mockApprovalModel.exists.mockResolvedValueOnce(null);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        { _id: factIdPm, value: { amount: 500000, unit: 'usd' }, chunkId: 'chunk-pm' },
        { _id: factIdSpreadsheet, value: { amount: 550000, unit: 'usd' }, chunkId: 'chunk-comps' },
      ]);
      // `computeProposalForConflict`'s own facts read — this time with enough sourceClass
      // information for `resolveConflictPolicy` to name a winner.
      mockExtractedFactModel.find.mockResolvedValueOnce([
        { _id: factIdPm, documentVersionId: documentVersionIdPm, observedAt: undefined },
        {
          _id: factIdSpreadsheet,
          documentVersionId: documentVersionIdSpreadsheet,
          observedAt: undefined,
        },
      ]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        { _id: documentVersionIdPm, documentId: documentIdPm },
        { _id: documentVersionIdSpreadsheet, documentId: documentIdSpreadsheet },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentIdPm, sourceClass: 'pm-export' },
        { _id: documentIdSpreadsheet, sourceClass: 'spreadsheet' },
      ]);
      mockWorkflowEngine.start.mockResolvedValueOnce({ id: 'wf-3', status: 'running' });
      mockWorkflowRunsService.create.mockResolvedValueOnce({
        id: 'run-3',
        workflowId: 'wf-3',
        status: 'running',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });

      await service.requestResolution({
        conflictId,
        winningFactId: factIdPm.toString(),
        actorId,
        requestedBy: 'analyst@example.com',
        tenantId: 'acme-corp',
      });

      expect(mockWorkflowEngine.start).toHaveBeenCalledWith(
        'resolveConflict',
        expect.objectContaining({
          ruleFired: 'authority',
          proposedWinnerFactId: factIdPm.toString(),
        }),
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
          tenantId: 'tenant-a',
        }),
      ).rejects.toThrow(InvalidConflictResolutionException);
      expect(mockWorkflowEngine.start).not.toHaveBeenCalled();
      expect(mockWorkflowRunsService.create).not.toHaveBeenCalled();
    });
  });

  describe('recordResolution', () => {
    const conflictId = new Types.ObjectId().toString();

    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };

    // Typed explicitly (not inferred from a `resolution: undefined` initializer, which would
    // narrow the field's type to the literal `undefined`) so `conflict.resolution?.resolvedAt`
    // below type-checks after the service mutates it in place.
    interface MockConflictDoc {
      status: string;
      factKey: { entity: string; metric: string; period: string };
      factIds: Types.ObjectId[];
      resolution?: {
        outcome: string;
        winningFactId?: Types.ObjectId;
        decidedBy?: string;
        reason?: string;
        resolvedAt: Date;
        ruleFired?: string;
        followedProposal?: boolean;
      };
      save: jest.Mock;
    }

    it('should throw ConflictNotFoundException without querying when conflictId is not a valid ObjectId', async () => {
      await expect(
        service.recordResolution({
          conflictId: 'not-an-id',
          outcome: 'timed_out',
          tenantId: 'tenant-a',
        }),
      ).rejects.toThrow(ConflictNotFoundException);
      expect(mockConflictModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw ConflictNotFoundException when no conflict matches', async () => {
      mockConflictModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.recordResolution({ conflictId, outcome: 'timed_out', tenantId: 'tenant-a' }),
      ).rejects.toThrow(ConflictNotFoundException);
      expect(mockConflictModel.findOne).toHaveBeenCalledWith({
        _id: conflictId,
        tenantId: 'tenant-a',
      });
    });

    it('should refuse to record any outcome for a conflict a metric-pack rescan already retracted', async () => {
      const conflict: MockConflictDoc = {
        status: 'dismissed',
        factKey,
        factIds: [],
        resolution: {
          outcome: 'retracted',
          resolvedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
        save: jest.fn(),
      };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      await expect(
        service.recordResolution({ conflictId, outcome: 'timed_out', tenantId: 'acme-corp' }),
      ).rejects.toThrow(InvalidConflictResolutionException);
      expect(conflict.save).not.toHaveBeenCalled();
    });

    it('should still record an outcome for a conflict that is dismissed for a reason other than retraction', async () => {
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = {
        status: 'dismissed',
        factKey,
        factIds: [],
        resolution: { outcome: 'resolved', resolvedAt: new Date('2026-07-01T00:00:00.000Z') },
        save: mockSave,
      };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      const result = await service.recordResolution({
        conflictId,
        outcome: 'timed_out',
        tenantId: 'acme-corp',
      });

      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ conflictId, outcome: 'timed_out' });
    });

    it('should record an approved resolution, set the winner, flip status to resolved, and record no proposal to follow when ruleFired is none', async () => {
      const winningFactId = new Types.ObjectId().toString();
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = {
        status: 'open',
        factKey,
        factIds: [],
        resolution: undefined,
        save: mockSave,
      };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      const result = await service.recordResolution({
        conflictId,
        outcome: 'resolved',
        winningFactId,
        decidedBy: 'reviewer@example.com',
        reason: 'Spreadsheet is the current underwriting figure.',
        tenantId: 'acme-corp',
        // What `requestResolution` captured at approval-request time — `cap_rate` has no
        // `authorityOrder`, so the proposal it captured was already `'none'`.
        ruleFired: 'none',
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
        ruleFired: 'none',
        followedProposal: undefined,
      });
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ conflictId, outcome: 'resolved' });
    });

    it('should record a rejected resolution with no winner, leave status untouched, and record no followedProposal', async () => {
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = {
        status: 'open',
        factKey,
        factIds: [],
        resolution: undefined,
        save: mockSave,
      };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      const result = await service.recordResolution({
        conflictId,
        outcome: 'rejected',
        decidedBy: 'reviewer@example.com',
        reason: 'Not enough context to confirm.',
        tenantId: 'acme-corp',
        ruleFired: 'none',
      });

      expect(conflict.status).toBe('open');
      expect(conflict.resolution?.resolvedAt).toBeInstanceOf(Date);
      expect(conflict.resolution).toMatchObject({
        outcome: 'rejected',
        winningFactId: undefined,
        decidedBy: 'reviewer@example.com',
        reason: 'Not enough context to confirm.',
        ruleFired: 'none',
        followedProposal: undefined,
      });
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ conflictId, outcome: 'rejected' });
    });

    it('should record a timed_out resolution with no winner, leave status untouched, and increment the approval-timeout counter', async () => {
      const approvalTimeoutSpy = jest.spyOn(approvalTimeoutCounter, 'add');
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = {
        status: 'open',
        factKey,
        factIds: [],
        resolution: undefined,
        save: mockSave,
      };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      const result = await service.recordResolution({
        conflictId,
        outcome: 'timed_out',
        tenantId: 'acme-corp',
        ruleFired: 'authority',
      });

      expect(conflict.status).toBe('open');
      expect(conflict.resolution).toMatchObject({ outcome: 'timed_out', ruleFired: 'authority' });
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ conflictId, outcome: 'timed_out' });
      expect(approvalTimeoutSpy).toHaveBeenCalledWith(1, { ruleFired: 'authority' });
    });

    it('should default the approval-timeout counter\'s ruleFired attribute to "none" when the workflow captured no proposal', async () => {
      const approvalTimeoutSpy = jest.spyOn(approvalTimeoutCounter, 'add');
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = {
        status: 'open',
        factKey,
        factIds: [],
        resolution: undefined,
        save: mockSave,
      };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      await service.recordResolution({ conflictId, outcome: 'timed_out', tenantId: 'acme-corp' });

      expect(approvalTimeoutSpy).toHaveBeenCalledWith(1, { ruleFired: 'none' });
    });

    it.each(['resolved', 'rejected'] as const)(
      'should not increment the approval-timeout counter for a %s outcome',
      async (outcome) => {
        const approvalTimeoutSpy = jest.spyOn(approvalTimeoutCounter, 'add');
        const mockSave = jest.fn().mockResolvedValueOnce(undefined);
        const conflict: MockConflictDoc = {
          status: 'open',
          factKey,
          factIds: [],
          resolution: undefined,
          save: mockSave,
        };
        mockConflictModel.findOne.mockResolvedValueOnce(conflict);

        await service.recordResolution({
          conflictId,
          outcome,
          winningFactId: outcome === 'resolved' ? new Types.ObjectId().toString() : undefined,
          tenantId: 'acme-corp',
        });

        expect(approvalTimeoutSpy).not.toHaveBeenCalled();
      },
    );

    it('should record no ruleFired and no followedProposal when replaying a resolveConflict history that started before proposal capture existed', async () => {
      const winningFactId = new Types.ObjectId().toString();
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const conflict: MockConflictDoc = {
        status: 'open',
        factKey,
        factIds: [],
        resolution: undefined,
        save: mockSave,
      };
      mockConflictModel.findOne.mockResolvedValueOnce(conflict);

      // Neither `ruleFired` nor `proposedWinnerFactId` is supplied — the same shape a stale,
      // pre-deploy `resolveConflict` execution would still carry (see
      // `ResolveConflictWorkflowInput`'s own doc comment).
      await service.recordResolution({
        conflictId,
        outcome: 'resolved',
        winningFactId,
        decidedBy: 'reviewer@example.com',
        reason: 'Confirmed against the rent roll.',
        tenantId: 'acme-corp',
      });

      expect(conflict.resolution).toMatchObject({
        outcome: 'resolved',
        ruleFired: undefined,
        followedProposal: undefined,
      });
    });

    describe('provenance captured at request time', () => {
      const authorityFactKey = {
        entity: 'Northgate Business Park',
        metric: 'net_operating_income',
        period: '2025-03',
      };

      const stubOpenConflict = (factIdPm: Types.ObjectId, factIdSpreadsheet: Types.ObjectId) => {
        const mockSave = jest.fn().mockResolvedValueOnce(undefined);
        const conflict: MockConflictDoc = {
          status: 'open',
          factKey: authorityFactKey,
          factIds: [factIdPm, factIdSpreadsheet],
          resolution: undefined,
          save: mockSave,
        };
        mockConflictModel.findOne.mockResolvedValueOnce(conflict);
        return { conflict, mockSave };
      };

      // Regression for the design defect this fix addresses: `recordResolution` must compare
      // against the proposal `requestResolution` captured, never a live recompute — proven
      // structurally, not just by outcome, since a recompute against the conflict's *current*
      // facts (e.g. after a document is reclassified during the 24h approval wait) could disagree
      // with the proposal the reviewer actually saw and acted on.
      it("should record followedProposal true from the proposal captured at request time, without ever reading the conflict's current facts", async () => {
        const factIdPm = new Types.ObjectId();
        const factIdSpreadsheet = new Types.ObjectId();
        const { conflict } = stubOpenConflict(factIdPm, factIdSpreadsheet);

        await service.recordResolution({
          conflictId,
          outcome: 'resolved',
          winningFactId: factIdPm.toString(),
          decidedBy: 'reviewer@example.com',
          reason: 'Rent roll is the operational record.',
          tenantId: 'acme-corp',
          ruleFired: 'authority',
          proposedWinnerFactId: factIdPm.toString(),
        });

        expect(conflict.resolution).toMatchObject({
          ruleFired: 'authority',
          followedProposal: true,
        });
        expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
        expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
        expect(mockDocumentModel.find).not.toHaveBeenCalled();
      });

      it('should record followedProposal false when the chosen winner overrides the proposal captured at request time', async () => {
        const factIdPm = new Types.ObjectId();
        const factIdSpreadsheet = new Types.ObjectId();
        const { conflict } = stubOpenConflict(factIdPm, factIdSpreadsheet);

        await service.recordResolution({
          conflictId,
          outcome: 'resolved',
          winningFactId: factIdSpreadsheet.toString(),
          decidedBy: 'reviewer@example.com',
          reason: 'The comps figure is more current.',
          tenantId: 'acme-corp',
          ruleFired: 'authority',
          proposedWinnerFactId: factIdPm.toString(),
        });

        expect(conflict.resolution).toMatchObject({
          ruleFired: 'authority',
          followedProposal: false,
        });
      });
    });
  });
});
