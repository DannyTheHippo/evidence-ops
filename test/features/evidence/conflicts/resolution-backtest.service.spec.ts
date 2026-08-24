import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { MetricPoliciesService } from '../../../../src/features/evidence/facts/metric-policies.service';
import { ResolutionBacktestService } from '../../../../src/features/evidence/conflicts/resolution-backtest.service';
import * as resolveConflictPolicyModule from '../../../../src/features/evidence/conflicts/resolve-conflict-policy';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('ResolutionBacktestService', () => {
  let service: ResolutionBacktestService;

  const mockConflictModel = getMockModel();
  const mockExtractedFactModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
  const mockDocumentModel = getMockModel();
  const mockMetricPoliciesService = { resolveForTenant: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResolutionBacktestService,
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: MetricPoliciesService, useValue: mockMetricPoliciesService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ResolutionBacktestService>(ResolutionBacktestService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns an empty report with a null agreementRate when there are no resolved conflicts', async () => {
    mockConflictModel.find.mockResolvedValueOnce([]);

    const result = await service.run('tenant-a');

    expect(mockConflictModel.find).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      'resolution.outcome': { $in: ['resolved', 'rejected', 'timed_out'] },
    });
    // Short-circuits before any policy read — nothing to score, nothing to resolve.
    expect(mockMetricPoliciesService.resolveForTenant).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      agreed: 0,
      disagreed: 0,
      silent: 0,
      unscorable: 0,
      agreementRate: null,
    });
  });

  // Negative control 1: a rejected resolution with no winner scores unscorable, not disagreed,
  // and resolveConflictPolicy is never reached.
  it("scores a 'rejected' resolution with no recorded winner as unscorable, without calling resolveConflictPolicy", async () => {
    const conflictId = new Types.ObjectId();
    const factIdA = new Types.ObjectId();
    const factIdB = new Types.ObjectId();
    const conflict = {
      _id: conflictId,
      factKey: { entity: 'Fenwick Logistics Center', metric: 'cap_rate', period: '2025-02' },
      factIds: [factIdA, factIdB],
      resolution: { outcome: 'rejected', resolvedAt: new Date() },
    };
    mockConflictModel.find.mockResolvedValueOnce([conflict]);
    mockMetricPoliciesService.resolveForTenant.mockResolvedValueOnce(new Map());
    mockExtractedFactModel.find.mockResolvedValueOnce([]);
    const policySpy = jest.spyOn(resolveConflictPolicyModule, 'resolveConflictPolicy');

    const result = await service.run('tenant-a');

    expect(result.results).toEqual([
      {
        conflictId: conflictId.toString(),
        factKey: conflict.factKey,
        verdict: 'unscorable',
        recordedOutcome: 'rejected',
        unscorableReason: "Outcome 'rejected' recorded no winning fact to score against.",
      },
    ]);
    expect(result.unscorable).toBe(1);
    expect(result.agreementRate).toBeNull();
    expect(policySpy).not.toHaveBeenCalled();
    // `resetAllMocks` in `afterEach` clears a spy's call history but not its wrapped
    // implementation, so leaving this spy in place would make every later test's real
    // `resolveConflictPolicy` call return `undefined` instead of running for real.
    policySpy.mockRestore();
  });

  // Negative control 2: a resolved conflict whose facts were deleted (reachable via
  // `DocumentsService.remove`'s status:'open'-scoped conflict update leaving a resolved
  // conflict's factIds dangling) scores unscorable, and resolveConflictPolicy is never called —
  // the spy proves the gate runs BEFORE the policy call, not merely that the label is right.
  it("scores a 'resolved' conflict whose facts no longer resolve as unscorable, without calling resolveConflictPolicy", async () => {
    const conflictId = new Types.ObjectId();
    const factIdA = new Types.ObjectId();
    const factIdB = new Types.ObjectId();
    const conflict = {
      _id: conflictId,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      factIds: [factIdA, factIdB],
      resolution: { outcome: 'resolved', winningFactId: factIdA, resolvedAt: new Date() },
    };
    mockConflictModel.find.mockResolvedValueOnce([conflict]);
    mockMetricPoliciesService.resolveForTenant.mockResolvedValueOnce(new Map());
    // Both facts were deleted along with their document — neither resolves.
    mockExtractedFactModel.find.mockResolvedValueOnce([]);
    const policySpy = jest.spyOn(resolveConflictPolicyModule, 'resolveConflictPolicy');

    const result = await service.run('tenant-a');

    expect(result.results).toEqual([
      {
        conflictId: conflictId.toString(),
        factKey: conflict.factKey,
        verdict: 'unscorable',
        recordedOutcome: 'resolved',
        recordedWinningFactId: factIdA.toString(),
        unscorableReason: '2 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
      },
    ]);
    expect(result.unscorable).toBe(1);
    expect(result.agreementRate).toBeNull();
    expect(policySpy).not.toHaveBeenCalled();
    policySpy.mockRestore();
  });

  it("scores 'silent' when the metric has an entry in the resolved map but no configured authorityOrder", async () => {
    const conflictId = new Types.ObjectId();
    const factIdA = new Types.ObjectId();
    const factIdB = new Types.ObjectId();
    const conflict = {
      _id: conflictId,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      factIds: [factIdA, factIdB],
      resolution: { outcome: 'resolved', winningFactId: factIdA, resolvedAt: new Date() },
    };
    const factA = {
      _id: factIdA,
      value: { amount: 5.25, unit: 'percent' },
      documentVersionId: new Types.ObjectId(),
      observedAt: undefined,
    };
    const factB = {
      _id: factIdB,
      value: { amount: 6.1, unit: 'percent' },
      documentVersionId: new Types.ObjectId(),
      observedAt: undefined,
    };
    mockConflictModel.find.mockResolvedValueOnce([conflict]);
    // `cap_rate` has an entry in this tenant's resolved map (Gate THREE's `policies.has` passes)
    // but no `authorityOrder` — the policy genuinely has no opinion, distinct from the metric
    // being absent from the tenant's active pack entirely (see the `unscorable` test below).
    mockMetricPoliciesService.resolveForTenant.mockResolvedValueOnce(
      new Map([['cap_rate', { authorityOrder: undefined, stalenessWindowMs: Infinity }]]),
    );
    mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([]);
    const policySpy = jest.spyOn(resolveConflictPolicyModule, 'resolveConflictPolicy');

    const result = await service.run('tenant-a');

    expect(policySpy).toHaveBeenCalledTimes(1);
    expect(mockDocumentModel.find).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      {
        conflictId: conflictId.toString(),
        factKey: conflict.factKey,
        verdict: 'silent',
        recordedOutcome: 'resolved',
        recordedWinningFactId: factIdA.toString(),
        replayedRuleFired: 'none',
      },
    ]);
    expect(result.silent).toBe(1);
    expect(result.agreementRate).toBeNull();
    policySpy.mockRestore();
  });

  // Gate THREE: a metric absent from the tenant's currently resolved active pack (dropped by a
  // pack revision since this conflict was detected) has no policy row to look up at all — this
  // must score `unscorable`, not `silent`, because there is no rule to author for a metric the
  // pack no longer contains. The spy proves the gate runs BEFORE the policy call.
  it("scores a conflict whose metric is absent from the tenant's active pack as unscorable, without calling resolveConflictPolicy", async () => {
    const conflictId = new Types.ObjectId();
    const factIdA = new Types.ObjectId();
    const factIdB = new Types.ObjectId();
    const conflict = {
      _id: conflictId,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      factIds: [factIdA, factIdB],
      resolution: { outcome: 'resolved', winningFactId: factIdA, resolvedAt: new Date() },
    };
    const factA = {
      _id: factIdA,
      value: { amount: 5.25, unit: 'percent' },
      documentVersionId: new Types.ObjectId(),
      observedAt: undefined,
    };
    const factB = {
      _id: factIdB,
      value: { amount: 6.1, unit: 'percent' },
      documentVersionId: new Types.ObjectId(),
      observedAt: undefined,
    };
    mockConflictModel.find.mockResolvedValueOnce([conflict]);
    // `cap_rate` has no entry at all in this tenant's resolved map — the active pack has dropped
    // it, distinct from an entry with no `authorityOrder` (the `silent` test above).
    mockMetricPoliciesService.resolveForTenant.mockResolvedValueOnce(new Map());
    mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
    // `run`'s batched `loadSourceClassByFactId` call runs before `scoreConflict` for any conflict
    // — it is not gated by Gate THREE, so it still queries here; resolving no versions makes the
    // downstream `documentModel.find` short-circuit, mirroring the `silent` test's own arrangement.
    mockDocumentVersionModel.find.mockResolvedValueOnce([]);
    const policySpy = jest.spyOn(resolveConflictPolicyModule, 'resolveConflictPolicy');

    const result = await service.run('tenant-a');

    expect(policySpy).not.toHaveBeenCalled();
    expect(mockDocumentModel.find).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      {
        conflictId: conflictId.toString(),
        factKey: conflict.factKey,
        verdict: 'unscorable',
        recordedOutcome: 'resolved',
        recordedWinningFactId: factIdA.toString(),
        unscorableReason: "Metric 'cap_rate' is not defined by the tenant's active metric pack.",
      },
    ]);
    expect(result.unscorable).toBe(1);
    expect(result.agreementRate).toBeNull();
    policySpy.mockRestore();
  });

  it("scores 'agreed' when the replayed rule's authority pick matches the recorded winner", async () => {
    const conflictId = new Types.ObjectId();
    const factIdPm = new Types.ObjectId();
    const factIdSpreadsheet = new Types.ObjectId();
    const conflict = {
      _id: conflictId,
      factKey: {
        entity: 'Northgate Business Park',
        metric: 'net_operating_income',
        period: '2025-03',
      },
      factIds: [factIdPm, factIdSpreadsheet],
      resolution: { outcome: 'resolved', winningFactId: factIdPm, resolvedAt: new Date() },
    };
    const documentVersionIdPm = new Types.ObjectId();
    const documentVersionIdSpreadsheet = new Types.ObjectId();
    const documentIdPm = new Types.ObjectId();
    const documentIdSpreadsheet = new Types.ObjectId();
    const factPm = {
      _id: factIdPm,
      value: { amount: 500000, unit: 'usd' },
      documentVersionId: documentVersionIdPm,
      observedAt: undefined,
    };
    const factSpreadsheet = {
      _id: factIdSpreadsheet,
      value: { amount: 550000, unit: 'usd' },
      documentVersionId: documentVersionIdSpreadsheet,
      observedAt: undefined,
    };
    mockConflictModel.find.mockResolvedValueOnce([conflict]);
    mockMetricPoliciesService.resolveForTenant.mockResolvedValueOnce(
      new Map([
        [
          'net_operating_income',
          { authorityOrder: ['pm-export', 'spreadsheet'], stalenessWindowMs: Infinity },
        ],
      ]),
    );
    mockExtractedFactModel.find.mockResolvedValueOnce([factPm, factSpreadsheet]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: documentVersionIdPm, documentId: documentIdPm },
      { _id: documentVersionIdSpreadsheet, documentId: documentIdSpreadsheet },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([
      { _id: documentIdPm, sourceClass: 'pm-export' },
      { _id: documentIdSpreadsheet, sourceClass: 'spreadsheet' },
    ]);

    const result = await service.run('tenant-a');

    expect(result.results).toEqual([
      {
        conflictId: conflictId.toString(),
        factKey: conflict.factKey,
        verdict: 'agreed',
        recordedOutcome: 'resolved',
        recordedWinningFactId: factIdPm.toString(),
        replayedRuleFired: 'authority',
        replayedWinningFactId: factIdPm.toString(),
      },
    ]);
    expect(result.agreed).toBe(1);
    expect(result.agreementRate).toBe(1);
  });

  it("scores 'disagreed' when the replayed rule's pick differs from the recorded winner, and computes agreementRate over scorable results only", async () => {
    const conflictId = new Types.ObjectId();
    const factIdPm = new Types.ObjectId();
    const factIdSpreadsheet = new Types.ObjectId();
    const conflict = {
      _id: conflictId,
      factKey: {
        entity: 'Fenwick Logistics Center',
        metric: 'net_operating_income',
        period: '2025-02',
      },
      factIds: [factIdPm, factIdSpreadsheet],
      // The human picked the spreadsheet figure; the current rule ranks pm-export higher.
      resolution: { outcome: 'resolved', winningFactId: factIdSpreadsheet, resolvedAt: new Date() },
    };
    const documentVersionIdPm = new Types.ObjectId();
    const documentVersionIdSpreadsheet = new Types.ObjectId();
    const documentIdPm = new Types.ObjectId();
    const documentIdSpreadsheet = new Types.ObjectId();
    const factPm = {
      _id: factIdPm,
      value: { amount: 500000, unit: 'usd' },
      documentVersionId: documentVersionIdPm,
      observedAt: undefined,
    };
    const factSpreadsheet = {
      _id: factIdSpreadsheet,
      value: { amount: 550000, unit: 'usd' },
      documentVersionId: documentVersionIdSpreadsheet,
      observedAt: undefined,
    };
    mockConflictModel.find.mockResolvedValueOnce([conflict]);
    mockMetricPoliciesService.resolveForTenant.mockResolvedValueOnce(
      new Map([
        [
          'net_operating_income',
          { authorityOrder: ['pm-export', 'spreadsheet'], stalenessWindowMs: Infinity },
        ],
      ]),
    );
    mockExtractedFactModel.find.mockResolvedValueOnce([factPm, factSpreadsheet]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: documentVersionIdPm, documentId: documentIdPm },
      { _id: documentVersionIdSpreadsheet, documentId: documentIdSpreadsheet },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([
      { _id: documentIdPm, sourceClass: 'pm-export' },
      { _id: documentIdSpreadsheet, sourceClass: 'spreadsheet' },
    ]);

    const result = await service.run('tenant-a');

    expect(result.results).toEqual([
      {
        conflictId: conflictId.toString(),
        factKey: conflict.factKey,
        verdict: 'disagreed',
        recordedOutcome: 'resolved',
        recordedWinningFactId: factIdSpreadsheet.toString(),
        replayedRuleFired: 'authority',
        replayedWinningFactId: factIdPm.toString(),
      },
    ]);
    expect(result.disagreed).toBe(1);
    // A single disagreed result with nothing else scorable: 0 agreed of 1 scored.
    expect(result.agreementRate).toBe(0);
  });

  it('folds a mixed batch of verdicts into counts and an agreementRate over scorable results only', async () => {
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const buildFact = (id: Types.ObjectId, amount: number) => ({
      _id: id,
      value: { amount, unit: 'percent' },
      documentVersionId: new Types.ObjectId(),
      observedAt: undefined,
    });

    // Agreed: recorded winner matches the replayed authority pick.
    const agreedConflictId = new Types.ObjectId();
    const agreedFactIdPm = new Types.ObjectId();
    const agreedFactIdSpreadsheet = new Types.ObjectId();
    const agreedFactPm = buildFact(agreedFactIdPm, 500000);
    const agreedFactSpreadsheet = buildFact(agreedFactIdSpreadsheet, 550000);
    const agreedDocumentVersionIdPm = agreedFactPm.documentVersionId;
    const agreedDocumentVersionIdSpreadsheet = agreedFactSpreadsheet.documentVersionId;
    const agreedDocumentIdPm = new Types.ObjectId();
    const agreedDocumentIdSpreadsheet = new Types.ObjectId();

    // Disagreed: recorded winner is the lower-authority fact.
    const disagreedConflictId = new Types.ObjectId();
    const disagreedFactIdPm = new Types.ObjectId();
    const disagreedFactIdSpreadsheet = new Types.ObjectId();
    const disagreedFactPm = buildFact(disagreedFactIdPm, 480000);
    const disagreedFactSpreadsheet = buildFact(disagreedFactIdSpreadsheet, 520000);
    const disagreedDocumentVersionIdPm = disagreedFactPm.documentVersionId;
    const disagreedDocumentVersionIdSpreadsheet = disagreedFactSpreadsheet.documentVersionId;
    const disagreedDocumentIdPm = new Types.ObjectId();
    const disagreedDocumentIdSpreadsheet = new Types.ObjectId();

    // Silent: cap_rate has no authorityOrder in this policy map.
    const silentConflictId = new Types.ObjectId();
    const silentFactIdA = new Types.ObjectId();
    const silentFactIdB = new Types.ObjectId();
    const silentFactA = buildFact(silentFactIdA, 5.25);
    const silentFactB = buildFact(silentFactIdB, 6.1);

    // Unscorable: a rejected attempt recorded no winner.
    const unscorableConflictId = new Types.ObjectId();
    const unscorableFactIdA = new Types.ObjectId();
    const unscorableFactIdB = new Types.ObjectId();

    const conflicts = [
      {
        _id: agreedConflictId,
        factKey: { entity: 'A', metric: 'net_operating_income', period: '2025-03' },
        factIds: [agreedFactIdPm, agreedFactIdSpreadsheet],
        resolution: { outcome: 'resolved', winningFactId: agreedFactIdPm, resolvedAt: new Date() },
      },
      {
        _id: disagreedConflictId,
        factKey: { entity: 'B', metric: 'net_operating_income', period: '2025-03' },
        factIds: [disagreedFactIdPm, disagreedFactIdSpreadsheet],
        resolution: {
          outcome: 'resolved',
          winningFactId: disagreedFactIdSpreadsheet,
          resolvedAt: new Date(),
        },
      },
      {
        _id: silentConflictId,
        factKey,
        factIds: [silentFactIdA, silentFactIdB],
        resolution: { outcome: 'resolved', winningFactId: silentFactIdA, resolvedAt: new Date() },
      },
      {
        _id: unscorableConflictId,
        factKey,
        factIds: [unscorableFactIdA, unscorableFactIdB],
        resolution: { outcome: 'timed_out', resolvedAt: new Date() },
      },
    ];
    mockConflictModel.find.mockResolvedValueOnce(conflicts);
    mockMetricPoliciesService.resolveForTenant.mockResolvedValueOnce(
      new Map([
        [
          'net_operating_income',
          { authorityOrder: ['pm-export', 'spreadsheet'], stalenessWindowMs: Infinity },
        ],
        // `cap_rate` has an entry (Gate THREE passes) but no `authorityOrder` — the silent
        // conflict's policy genuinely has no opinion, distinct from the metric being absent from
        // the active pack.
        ['cap_rate', { authorityOrder: undefined, stalenessWindowMs: Infinity }],
      ]),
    );
    mockExtractedFactModel.find.mockResolvedValueOnce([
      agreedFactPm,
      agreedFactSpreadsheet,
      disagreedFactPm,
      disagreedFactSpreadsheet,
      silentFactA,
      silentFactB,
    ]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: agreedDocumentVersionIdPm, documentId: agreedDocumentIdPm },
      { _id: agreedDocumentVersionIdSpreadsheet, documentId: agreedDocumentIdSpreadsheet },
      { _id: disagreedDocumentVersionIdPm, documentId: disagreedDocumentIdPm },
      {
        _id: disagreedDocumentVersionIdSpreadsheet,
        documentId: disagreedDocumentIdSpreadsheet,
      },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([
      { _id: agreedDocumentIdPm, sourceClass: 'pm-export' },
      { _id: agreedDocumentIdSpreadsheet, sourceClass: 'spreadsheet' },
      { _id: disagreedDocumentIdPm, sourceClass: 'pm-export' },
      { _id: disagreedDocumentIdSpreadsheet, sourceClass: 'spreadsheet' },
    ]);

    const result = await service.run('tenant-a');

    expect(result.agreed).toBe(1);
    expect(result.disagreed).toBe(1);
    expect(result.silent).toBe(1);
    expect(result.unscorable).toBe(1);
    // Silent and unscorable count toward neither side: agreed 1 of 2 scorable.
    expect(result.agreementRate).toBe(0.5);
    expect(result.results).toHaveLength(4);
  });
});
