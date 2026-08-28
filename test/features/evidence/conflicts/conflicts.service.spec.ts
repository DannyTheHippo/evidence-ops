import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { Approval } from '../../../../src/database/schemas/workflow/approval/approval.schema';
import { ConflictsService } from '../../../../src/features/evidence/conflicts/conflicts.service';
import {
  ConflictNotFoundException,
  ConflictResolutionAlreadyPendingException,
  InvalidConflictResolutionException,
} from '../../../../src/features/evidence/conflicts/exceptions/conflicts.exception';
import * as resolveConflictPolicyModule from '../../../../src/features/evidence/conflicts/resolve-conflict-policy';
import {
  ACTIVE_PACK_ID,
  ACTIVE_PACK_VERSION,
} from '../../../../src/features/evidence/facts/metric-ontology';
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
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const buildFact = (
    factKey: { entity: string; metric: string; period: string },
    value: { amount: number; unit: string },
  ) => ({
    _id: new Types.ObjectId(),
    factKey,
    value,
    // Every scan query now projects `documentVersionId` too (`excludeSupersededFacts`), so a fact
    // fixture omitting it would no longer match what a real Mongo projection returns. Left
    // unresolvable by default (`mockDocumentVersionModel.find` resolves `[]` unless a test
    // overrides it), which `excludeSupersededFacts` keeps rather than drops — see that method's own
    // doc comment.
    documentVersionId: new Types.ObjectId(),
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
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ConflictsService>(ConflictsService);

    // Default for `excludeSupersededFacts`'s two lookups: no version/document resolves, so every
    // scan test that isn't specifically exercising supersession keeps every fact unchanged — see
    // that method's own "unresolvable is kept" doc comment. `mockResolvedValueOnce` in an
    // individual test still takes priority over this base implementation.
    mockDocumentVersionModel.find.mockResolvedValue([]);
    mockDocumentModel.find.mockResolvedValue([]);
    // Default for `detectAndPersist`'s existing-conflicts lookup (retraction and idempotency): no
    // open conflict to retract or grow, so every scan test that isn't specifically exercising
    // either keeps this a no-op. `mockResolvedValueOnce` in an individual test still takes
    // priority.
    mockConflictModel.find.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should full-scan via a cursor when factKeys is omitted', async () => {
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([]));

    const result = await service.scanForConflicts('acme-corp');

    expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
      { tenantId: 'acme-corp' },
      { factKey: 1, value: 1, documentVersionId: 1 },
    );
    expect(mockConflictModel.find).not.toHaveBeenCalled();
    expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
  });

  it('should return conflictsCreated 0, still checking for a retractable open conflict, when normalized values agree within tolerance', async () => {
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
      { factKey: 1, value: 1, documentVersionId: 1 },
    );
    // No candidate this scan (values agree), so `findRetractableConflicts` still needs the
    // tenant's existing conflicts to know whether one needs closing — the default empty result
    // (`beforeEach`) means there is nothing to retract here.
    expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId });
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
    expect(insertedConflicts[0].packId).toBe(ACTIVE_PACK_ID);
    expect(insertedConflicts[0].packVersion).toBe(ACTIVE_PACK_VERSION);
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

  it('should leave an open Conflict record untouched when the candidate factIds are unchanged', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
    const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
    const mockSave = jest.fn();
    mockConflictModel.find.mockResolvedValueOnce([
      { factKey, status: 'open', factIds: [factLow._id, factHigh._id], save: mockSave },
    ]);

    const result = await service.scanForConflicts(tenantId);

    expect(mockConflictModel.insertMany).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
  });

  it('should grow an open Conflict record in place, never insert a duplicate, when a third fact joins the same disagreement', async () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const factLow = buildFact(factKey, { amount: 5.25, unit: 'percent' });
    const factHigh = buildFact(factKey, { amount: 6.1, unit: 'percent' });
    const factNew = buildFact(factKey, { amount: 6.5, unit: 'percent' });
    mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh, factNew]));
    const mockSave = jest.fn().mockResolvedValueOnce(undefined);
    const openConflict = {
      _id: new Types.ObjectId(),
      factKey,
      status: 'open',
      factIds: [factLow._id, factHigh._id],
      magnitude: 0.0085,
      magnitudeUnit: 'ratio',
      save: mockSave,
    };
    mockConflictModel.find.mockResolvedValueOnce([openConflict]);

    const result = await service.scanForConflicts(tenantId);

    expect(mockConflictModel.insertMany).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(openConflict.factIds.map((id) => id.toString())).toEqual(
      [factLow._id, factHigh._id, factNew._id].map((id) => id.toString()),
    );
    expect(openConflict.magnitude).toBeCloseTo(0.0125, 4);
    expect(openConflict.magnitudeUnit).toBe('ratio');
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

  describe('supersession (a corrected re-upload must not conflict with the version it corrected)', () => {
    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const documentId = new Types.ObjectId();
    const priorVersionId = new Types.ObjectId();
    const currentVersionId = new Types.ObjectId();

    it('should exclude a superseded version’s fact and detect no conflict against the current version’s own value', async () => {
      const priorFact = {
        ...buildFact(factKey, { amount: 5.25, unit: 'percent' }),
        documentVersionId: priorVersionId,
      };
      const currentFact = {
        ...buildFact(factKey, { amount: 5.3, unit: 'percent' }),
        documentVersionId: currentVersionId,
      };
      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([priorFact, currentFact]));
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        { _id: priorVersionId, documentId },
        { _id: currentVersionId, documentId },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([{ _id: documentId, currentVersionId }]);

      const result = await service.scanForConflicts(tenantId);

      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        { _id: { $in: [priorVersionId, currentVersionId] }, tenantId },
        { documentId: 1 },
      );
      expect(mockDocumentModel.find).toHaveBeenCalledWith(
        { _id: { $in: [documentId] }, tenantId },
        { currentVersionId: 1 },
      );
      // A single normalizable fact is left (the prior version's excluded) — nothing left to
      // disagree with, so no new conflict is created. `conflictModel.find` still runs
      // (`findRetractableConflicts` needs the group's existing conflicts, if any, to know whether
      // one needs closing) — the default empty result (`beforeEach`) means there is none here.
      expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId });
      expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
    });

    it('should still detect a genuine conflict between two facts that both belong to the current version', async () => {
      const factLow = {
        ...buildFact(factKey, { amount: 5.25, unit: 'percent' }),
        documentVersionId: currentVersionId,
      };
      const factHigh = {
        ...buildFact(factKey, { amount: 6.1, unit: 'percent' }),
        documentVersionId: currentVersionId,
      };
      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
      mockDocumentVersionModel.find.mockResolvedValueOnce([{ _id: currentVersionId, documentId }]);
      mockDocumentModel.find.mockResolvedValueOnce([{ _id: documentId, currentVersionId }]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.scanForConflicts(tenantId);

      expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
    });

    it('should keep a fact whose document has no currentVersionId set yet, rather than drop it', async () => {
      const factLow = {
        ...buildFact(factKey, { amount: 5.25, unit: 'percent' }),
        documentVersionId: currentVersionId,
      };
      const factHigh = {
        ...buildFact(factKey, { amount: 6.1, unit: 'percent' }),
        documentVersionId: currentVersionId,
      };
      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
      mockDocumentVersionModel.find.mockResolvedValueOnce([{ _id: currentVersionId, documentId }]);
      // The document row resolves, but carries no `currentVersionId` yet.
      mockDocumentModel.find.mockResolvedValueOnce([{ _id: documentId }]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.scanForConflicts(tenantId);

      expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
    });

    it('should keep a fact whose document version no longer resolves, rather than drop it', async () => {
      const factLow = {
        ...buildFact(factKey, { amount: 5.25, unit: 'percent' }),
        documentVersionId: currentVersionId,
      };
      const factHigh = {
        ...buildFact(factKey, { amount: 6.1, unit: 'percent' }),
        documentVersionId: currentVersionId,
      };
      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factLow, factHigh]));
      // Neither fact's `documentVersionId` resolves to a `DocumentVersion` row.
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.scanForConflicts(tenantId);

      expect(mockDocumentModel.find).not.toHaveBeenCalled();
      expect(result).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });
    });
  });

  describe('retraction (an open conflict whose group stops disagreeing must not force conflicting_evidence forever)', () => {
    // Locally typed (mirrors `recordResolution`'s own `MockConflictDoc`) so the mutations
    // `detectAndPersist` makes in place — `status`, `resolution` — type-check without widening
    // `openConflict` to `any`.
    interface MockRetractableConflictDoc {
      _id: Types.ObjectId;
      factKey: { entity: string; metric: string; period: string };
      status: string;
      factIds: Types.ObjectId[];
      resolution?: {
        outcome: string;
        resolvedAt: Date;
        packId: string;
        packVersion: number;
      };
      save: jest.Mock;
    }

    const tenantId = 'acme-corp';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const documentAId = new Types.ObjectId();
    const documentBId = new Types.ObjectId();
    const documentAVersion1Id = new Types.ObjectId();
    const documentAVersion2Id = new Types.ObjectId();
    const documentBVersionId = new Types.ObjectId();

    it('should retract the open conflict once a corrected re-upload stops disagreeing with the other document', async () => {
      // Step 1 — the original ingest: Document A v1 states 5.25%, Document B states 6.10%, an
      // 85bp spread past cap_rate's 25bp tolerance, so the scan opens a conflict.
      const factA1 = {
        ...buildFact(factKey, { amount: 5.25, unit: 'percent' }),
        documentVersionId: documentAVersion1Id,
      };
      const factB1 = {
        ...buildFact(factKey, { amount: 6.1, unit: 'percent' }),
        documentVersionId: documentBVersionId,
      };
      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factA1, factB1]));
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        { _id: documentAVersion1Id, documentId: documentAId },
        { _id: documentBVersionId, documentId: documentBId },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentAId, currentVersionId: documentAVersion1Id },
        { _id: documentBId, currentVersionId: documentBVersionId },
      ]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockConflictModel.insertMany.mockResolvedValueOnce([]);

      const firstScan = await service.scanForConflicts(tenantId);

      expect(firstScan).toEqual({ conflictsCreated: 1, skippedFactCount: 0 });

      // Step 2 — Document A is re-uploaded as v2, correcting its value to 6.10%: agrees with
      // Document B, so this rescan finds no candidate for the group. `resetAllMocks` also wipes
      // the `beforeEach` defaults — restore them, same pattern the incremental-scan parity test
      // above uses.
      jest.resetAllMocks();
      mockDocumentVersionModel.find.mockResolvedValue([]);
      mockDocumentModel.find.mockResolvedValue([]);
      mockConflictModel.find.mockResolvedValue([]);

      const factA1StillStored = {
        ...buildFact(factKey, { amount: 5.25, unit: 'percent' }),
        _id: factA1._id,
        documentVersionId: documentAVersion1Id,
      };
      const factA2 = {
        ...buildFact(factKey, { amount: 6.1, unit: 'percent' }),
        documentVersionId: documentAVersion2Id,
      };
      const factB1StillStored = {
        ...buildFact(factKey, { amount: 6.1, unit: 'percent' }),
        _id: factB1._id,
        documentVersionId: documentBVersionId,
      };
      mockExtractedFactModel.find.mockReturnValueOnce(
        asCursor([factA1StillStored, factA2, factB1StillStored]),
      );
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        { _id: documentAVersion1Id, documentId: documentAId },
        { _id: documentAVersion2Id, documentId: documentAId },
        { _id: documentBVersionId, documentId: documentBId },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        // Document A now points at v2 — v1's fact is superseded and excluded.
        { _id: documentAId, currentVersionId: documentAVersion2Id },
        { _id: documentBId, currentVersionId: documentBVersionId },
      ]);
      const mockSave = jest.fn().mockResolvedValueOnce(undefined);
      const openConflict: MockRetractableConflictDoc = {
        _id: new Types.ObjectId(),
        factKey,
        status: 'open',
        factIds: [factA1._id, factB1._id],
        save: mockSave,
      };
      mockConflictModel.find.mockResolvedValueOnce([openConflict]);

      const secondScan = await service.scanForConflicts(tenantId);

      expect(secondScan).toEqual({ conflictsCreated: 0, skippedFactCount: 0 });
      expect(mockConflictModel.insertMany).not.toHaveBeenCalled();
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(openConflict.status).toBe('dismissed');
      // `resolvedAt` asserted separately, not via `expect.any(Date)` inside the object literal —
      // see `recordResolution`'s own spec for why (`no-unsafe-assignment` on `expect.any`'s
      // `any`-typed return).
      expect(openConflict.resolution?.resolvedAt).toBeInstanceOf(Date);
      expect(openConflict.resolution).toMatchObject({
        outcome: 'retracted',
        packId: ACTIVE_PACK_ID,
        packVersion: ACTIVE_PACK_VERSION,
      });
    });

    it('should NOT retract an open conflict whose group had a fact skipped this scan for an unrecognized unit', async () => {
      // The group's only current facts this scan are un-normalizable, so `detectConflicts`
      // neither confirms nor refutes the disagreement — retracting here would silently close a
      // conflict that may still be live.
      const factA = {
        ...buildFact(factKey, { amount: 250, unit: 'usd' }),
        documentVersionId: documentAVersion1Id,
      };
      mockExtractedFactModel.find.mockReturnValueOnce(asCursor([factA]));
      const mockSave = jest.fn();
      const openConflict = {
        _id: new Types.ObjectId(),
        factKey,
        status: 'open',
        factIds: [factA._id, new Types.ObjectId()],
        save: mockSave,
      };
      mockConflictModel.find.mockResolvedValueOnce([openConflict]);

      const result = await service.scanForConflicts(tenantId);

      expect(mockSave).not.toHaveBeenCalled();
      expect(openConflict.status).toBe('open');
      expect(result).toEqual({ conflictsCreated: 0, skippedFactCount: 1 });
    });
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
        { factKey: 1, value: 1, documentVersionId: 1 },
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
        { factKey: 1, value: 1, documentVersionId: 1 },
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
        { factKey: 1, value: 1, documentVersionId: 1 },
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
      // `resetAllMocks` also wipes the `beforeEach` defaults for `excludeSupersededFacts`'s two
      // lookups — restore them so this mid-test reset behaves like every other scan.
      mockDocumentVersionModel.find.mockResolvedValue([]);
      mockDocumentModel.find.mockResolvedValue([]);
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

  describe('findConflictedFactGroupsForTenant', () => {
    it('should return an empty array without querying facts when the tenant has no open conflicts', async () => {
      mockConflictModel.find.mockResolvedValueOnce([]);

      const result = await service.findConflictedFactGroupsForTenant('acme-corp');

      expect(mockConflictModel.find).toHaveBeenCalledWith({
        tenantId: 'acme-corp',
        status: 'open',
      });
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should project every open conflict for the tenant, never scoped by chunkIds', async () => {
      const factIdXlsx = new Types.ObjectId();
      const factIdProse = new Types.ObjectId();
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      const conflict = {
        _id: new Types.ObjectId(),
        factKey,
        factIds: [factIdXlsx, factIdProse],
      };
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        { _id: factIdXlsx, value: { amount: 5.25, unit: 'percent' }, chunkId: 'chunk-xlsx' },
        { _id: factIdProse, value: { amount: 6.1, unit: 'percent' }, chunkId: 'chunk-prose' },
      ]);

      const result = await service.findConflictedFactGroupsForTenant('acme-corp');

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        _id: { $in: [factIdXlsx, factIdProse] },
        tenantId: 'acme-corp',
      });
      expect(result).toEqual([
        {
          conflictId: conflict._id.toString(),
          factKey,
          values: [
            { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
            { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
          ],
        },
      ]);
    });

    it('should skip and log a conflict with a dangling factId rather than throw, so one bad row does not break unrelated questions', async () => {
      const goodFactKey = {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: '2025-03',
      };
      const goodFactId = new Types.ObjectId();
      const otherGoodFactId = new Types.ObjectId();
      const goodConflict = {
        _id: new Types.ObjectId(),
        factKey: goodFactKey,
        factIds: [goodFactId, otherGoodFactId],
      };
      const brokenFactKey = {
        entity: 'Sablewood Retail Court',
        metric: 'cap_rate',
        period: '2025-04',
      };
      const survivingFactId = new Types.ObjectId();
      const missingFactId = new Types.ObjectId();
      const brokenConflict = {
        _id: new Types.ObjectId(),
        factKey: brokenFactKey,
        factIds: [survivingFactId, missingFactId],
      };
      mockConflictModel.find.mockResolvedValueOnce([brokenConflict, goodConflict]);
      mockExtractedFactModel.find.mockResolvedValueOnce([
        { _id: goodFactId, value: { amount: 5.25, unit: 'percent' }, chunkId: 'chunk-xlsx' },
        { _id: otherGoodFactId, value: { amount: 6.1, unit: 'percent' }, chunkId: 'chunk-prose' },
        { _id: survivingFactId, value: { amount: 5.0, unit: 'percent' }, chunkId: 'chunk-sable' },
        // `missingFactId` never resolves — the dangling reference.
      ]);

      const result = await service.findConflictedFactGroupsForTenant('acme-corp');

      expect(result).toEqual([
        {
          conflictId: goodConflict._id.toString(),
          factKey: goodFactKey,
          values: [
            { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
            { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
          ],
        },
      ]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Conflict '${brokenConflict._id.toString()}'`),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('references 2 fact(s), but only 1'),
      );
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
        packId: ACTIVE_PACK_ID,
        packVersion: ACTIVE_PACK_VERSION,
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

    it.each([
      ['createdAt', 'asc', { createdAt: 1 }],
      ['status', 'desc', { status: -1 }],
    ] as const)(
      'should sort by the caller-supplied %s field and %s direction',
      async (sort, sortDir, expectedSort) => {
        const actorId = new Types.ObjectId().toString();
        mockConflictModel.find.mockResolvedValueOnce([]);
        mockConflictModel.countDocuments.mockResolvedValueOnce(0);
        mockAuditService.record.mockResolvedValueOnce(undefined);

        await service.list({ skip: 0, limit: 20, sort, sortDir }, actorId, 'tenant-a');

        expect(mockConflictModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
          sort: expectedSort,
          skip: 0,
          limit: 20,
        });
      },
    );

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
        packId: ACTIVE_PACK_ID,
        packVersion: ACTIVE_PACK_VERSION + 1,
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
        `${ACTIVE_PACK_ID}' v${ACTIVE_PACK_VERSION + 1}`,
      );
      expect(result.docs[0].staleReason).toContain(`${ACTIVE_PACK_ID}' v${ACTIVE_PACK_VERSION}`);
      // Staleness is independent of unscorability — this row's evidence is fully intact.
      expect(result.docs[0].unscorable).toBe(false);
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

    it('should scope the query to an explicit tenantId and skip the fact and document queries entirely for an empty page', async () => {
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
        packId: ACTIVE_PACK_ID,
        packVersion: ACTIVE_PACK_VERSION,
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
      // beyond `loadConflictForResolution`'s own.
      expect(mockExtractedFactModel.find).toHaveBeenCalledTimes(1);
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

    it('should refuse to record any outcome for a previously-retracted conflict', async () => {
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
