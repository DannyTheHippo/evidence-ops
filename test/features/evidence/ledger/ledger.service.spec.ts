import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { CanonicalEntityService } from '../../../../src/features/evidence/facts/canonical-entity.service';
import type { MeasureDefinition } from '../../../../src/features/evidence/measures/measure-definition';
import { MeasureNotFoundException } from '../../../../src/features/evidence/measures/exceptions/measures.exception';
import { MeasuresService } from '../../../../src/features/evidence/measures/measures.service';
import { LedgerService } from '../../../../src/features/evidence/ledger/ledger.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

const TENANT_ID = 'acme-corp';

function buildMeasureDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT_ID,
    slug: 'cap_rate',
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
    status: 'confirmed',
    origin: 'seed',
    version: 1,
    ...overrides,
  };
}

function buildMeasureDefinition(overrides: Partial<MeasureDefinition> = {}): MeasureDefinition {
  const doc = buildMeasureDoc(overrides);
  return {
    id: doc.slug,
    label: doc.label,
    aliases: doc.aliases,
    valueType: doc.valueType as MeasureDefinition['valueType'],
    canonicalUnit: doc.canonicalUnit,
    units: doc.units,
    toleranceKind: doc.toleranceKind as MeasureDefinition['toleranceKind'],
    tolerance: doc.tolerance,
    measureId: doc._id.toString(),
    version: doc.version,
    status: doc.status as MeasureDefinition['status'],
    origin: doc.origin as MeasureDefinition['origin'],
    ...overrides,
  };
}

function buildFact(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    factKey: { entity: 'Northgate Plaza', metric: 'cap_rate', period: '2025-03' },
    value: { amount: 5.25, unit: 'percent' },
    groupKeyNormalized: 'northgate plaza::cap_rate::2025-03',
    rawText: '5.25%',
    confidence: 0.9,
    extractionMethod: 'llm',
    measureId: new Types.ObjectId(),
    measureVersion: 1,
    measureStatus: 'confirmed',
    chunkId: 'chunk-1',
    documentVersionId: new Types.ObjectId(),
    locator: { kind: 'xlsx-cell', sheetName: 'Sheet1', cell: 'B2', extractorVersion: 'v1' },
    tenantId: TENANT_ID,
    observedAt: new Date('2025-03-01'),
    createdAt: new Date('2025-03-02'),
    entityMatched: true,
    ...overrides,
  };
}

function buildConflict(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT_ID,
    factKey: { entity: 'Northgate Plaza', metric: 'cap_rate', period: '2025-03' },
    groupKeyNormalized: 'northgate plaza::cap_rate::2025-03',
    factIds: [],
    magnitude: 0.01,
    magnitudeUnit: 'ratio',
    packId: 'cre',
    packVersion: 1,
    status: 'open',
    createdAt: new Date('2025-03-03'),
    ...overrides,
  };
}

function lifecycleVersionRow(
  versionId: Types.ObjectId,
  documentId: Types.ObjectId,
  sha256: string,
) {
  return { _id: versionId, documentId, sha256, withdrawnAt: undefined };
}

describe('LedgerService', () => {
  let service: LedgerService;

  const mockExtractedFactModel = getMockModel();
  const mockConflictModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
  const mockDocumentModel = getMockModel();
  const mockCanonicalEntityService = { resolveMany: jest.fn() };
  const mockMeasuresService = {
    findBySlug: jest.fn(),
    listConfirmedDefinitions: jest.fn(),
  };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: CanonicalEntityService, useValue: mockCanonicalEntityService },
        { provide: MeasuresService, useValue: mockMeasuresService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('the exclusion rule', () => {
    it.each([
      [
        'resolveValue',
        async () => {
          mockMeasuresService.findBySlug.mockResolvedValueOnce(
            buildMeasureDoc({ status: 'confirmed' }),
          );
          mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
            { name: 'Northgate Plaza', matched: true },
          ]);
          mockExtractedFactModel.find.mockResolvedValueOnce([]);
          mockConflictModel.find.mockResolvedValueOnce([]);

          await service.resolveValue({
            tenantId: TENANT_ID,
            entity: 'Northgate',
            measure: 'cap_rate',
          });

          expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: TENANT_ID, measureStatus: 'confirmed' }),
          );
        },
      ],
      [
        'listCells',
        async () => {
          mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);
          mockExtractedFactModel.aggregate.mockResolvedValueOnce([{ docs: [], count: [] }]);

          await service.listCells(TENANT_ID, {});

          const [pipeline] = mockExtractedFactModel.aggregate.mock.calls[0] as [
            Record<string, unknown>[],
          ];
          expect(pipeline[0].$match).toEqual(
            expect.objectContaining({ tenantId: TENANT_ID, measureStatus: 'confirmed' }),
          );
        },
      ],
    ])('%s filters its fact query to confirmed measures', async (_name, run) => {
      await run();
    });

    it('listFacts does not filter by measureStatus — it is the drill-down showing every status', async () => {
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockMeasuresService.findBySlug.mockResolvedValueOnce(null);

      await service.listFacts(TENANT_ID, { entity: 'Northgate', measure: 'cap_rate' });

      const [filter] = mockExtractedFactModel.find.mock.calls[0] as [Record<string, unknown>];
      expect(filter).not.toHaveProperty('measureStatus');
      expect(filter.tenantId).toBe(TENANT_ID);
      expect(typeof filter.groupKeyNormalized).toBe('string');
    });
  });

  describe('resolveValue', () => {
    it('throws MeasureNotFoundException for an unknown measure slug', async () => {
      mockMeasuresService.findBySlug.mockResolvedValueOnce(null);

      await expect(
        service.resolveValue({
          tenantId: TENANT_ID,
          entity: 'Northgate',
          measure: 'unknown_metric',
        }),
      ).rejects.toBeInstanceOf(MeasureNotFoundException);
      expect(mockCanonicalEntityService.resolveMany).not.toHaveBeenCalled();
    });

    it('throws MeasureNotFoundException for a rejected measure', async () => {
      mockMeasuresService.findBySlug.mockResolvedValueOnce(buildMeasureDoc({ status: 'rejected' }));

      await expect(
        service.resolveValue({ tenantId: TENANT_ID, entity: 'Northgate', measure: 'cap_rate' }),
      ).rejects.toBeInstanceOf(MeasureNotFoundException);
    });

    it('returns unknown for a proposed measure, with the entity and period still resolved', async () => {
      mockMeasuresService.findBySlug.mockResolvedValueOnce(buildMeasureDoc({ status: 'proposed' }));
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);

      const result = await service.resolveValue({
        tenantId: TENANT_ID,
        entity: 'northgate',
        measure: 'cap_rate',
        period: 'March 2025',
      });

      expect(result).toEqual({
        entity: 'Northgate Plaza',
        measure: 'cap_rate',
        period: '2025-03',
        state: 'unknown',
        factIds: [],
        citations: [],
      });
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
    });

    it('resolves a confirmed measure through the canonical entity name and a stated period', async () => {
      const measureDoc = buildMeasureDoc({ status: 'confirmed' });
      mockMeasuresService.findBySlug.mockResolvedValueOnce(measureDoc);
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      const fact = buildFact();
      mockExtractedFactModel.find.mockResolvedValueOnce([fact]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      const documentId = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        lifecycleVersionRow(fact.documentVersionId, documentId, 'a'.repeat(64)),
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentId, currentVersionId: fact.documentVersionId },
      ]);

      const result = await service.resolveValue({
        tenantId: TENANT_ID,
        entity: 'north gate plaza',
        measure: 'cap_rate',
        period: 'March 2025',
      });

      expect(mockCanonicalEntityService.resolveMany).toHaveBeenCalledWith(
        ['north gate plaza'],
        TENANT_ID,
      );
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        groupKeyNormalized: 'northgate plaza::cap_rate::2025-03',
        measureStatus: 'confirmed',
      });
      expect(result.entity).toBe('Northgate Plaza');
      expect(result.period).toBe('2025-03');
      expect(result.state).toBe('single');
      expect(result.citations).toEqual([
        expect.objectContaining({
          factId: fact._id.toString(),
          documentId: documentId.toString(),
          sha256: 'a'.repeat(64),
          quote: fact.rawText,
          extractorVersion: 'v1',
          withdrawn: false,
        }),
      ]);
    });

    it('resolves an absent period to undated', async () => {
      mockMeasuresService.findBySlug.mockResolvedValueOnce(
        buildMeasureDoc({ status: 'confirmed' }),
      );
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockConflictModel.find.mockResolvedValueOnce([]);

      const result = await service.resolveValue({
        tenantId: TENANT_ID,
        entity: 'Northgate Plaza',
        measure: 'cap_rate',
      });

      expect(result.period).toBe('undated');
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ groupKeyNormalized: 'northgate plaza::cap_rate::undated' }),
      );
    });

    it('reports conflicted with the open conflict id, citing every fact it names', async () => {
      mockMeasuresService.findBySlug.mockResolvedValueOnce(
        buildMeasureDoc({ status: 'confirmed' }),
      );
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      const factA = buildFact({ value: { amount: 5.25, unit: 'percent' } });
      const factB = buildFact({
        _id: new Types.ObjectId(),
        value: { amount: 6.1, unit: 'percent' },
      });
      const conflict = buildConflict({ factIds: [factA._id, factB._id] });
      mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      const documentId = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        lifecycleVersionRow(factA.documentVersionId, documentId, 'e'.repeat(64)),
        lifecycleVersionRow(factB.documentVersionId, documentId, 'f'.repeat(64)),
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentId, currentVersionId: factA.documentVersionId },
      ]);

      const result = await service.resolveValue({
        tenantId: TENANT_ID,
        entity: 'Northgate Plaza',
        measure: 'cap_rate',
      });

      expect(result.state).toBe('conflicted');
      expect(result.conflictId).toBe(conflict._id.toString());
      expect(result.citations).toHaveLength(2);
    });

    it('omits a citation, with a warn, for a fact whose lifecycle does not resolve', async () => {
      mockMeasuresService.findBySlug.mockResolvedValueOnce(
        buildMeasureDoc({ status: 'confirmed' }),
      );
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      const fact = buildFact();
      mockExtractedFactModel.find.mockResolvedValueOnce([fact]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockDocumentModel.find.mockResolvedValueOnce([]);

      const result = await service.resolveValue({
        tenantId: TENANT_ID,
        entity: 'Northgate Plaza',
        measure: 'cap_rate',
      });

      expect(result.state).toBe('unknown');
      expect(result.citations).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    // A conflicted cell takes its `factIds` from the conflict row, not from the facts the query
    // returned — so a conflict naming a fact that no longer resolves (deleted, or since restamped
    // under a measure this query filters out) reaches the citation builder with nothing to cite.
    // It must drop that citation rather than emit one with a blank sha256: a citation a recipient
    // cannot re-check against bytes is worse than no citation at all.
    it('drops a citation for a fact a conflict names but the query did not return', async () => {
      mockMeasuresService.findBySlug.mockResolvedValueOnce(
        buildMeasureDoc({ status: 'confirmed' }),
      );
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      const factA = buildFact({ value: { amount: 5.25, unit: 'percent' } });
      const factB = buildFact({
        _id: new Types.ObjectId(),
        value: { amount: 6.1, unit: 'percent' },
      });
      const vanishedFactId = new Types.ObjectId();
      const conflict = buildConflict({ factIds: [factA._id, factB._id, vanishedFactId] });
      mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      const documentId = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        lifecycleVersionRow(factA.documentVersionId, documentId, 'e'.repeat(64)),
        lifecycleVersionRow(factB.documentVersionId, documentId, 'f'.repeat(64)),
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentId, currentVersionId: factA.documentVersionId },
      ]);

      const result = await service.resolveValue({
        tenantId: TENANT_ID,
        entity: 'Northgate Plaza',
        measure: 'cap_rate',
      });

      expect(result.state).toBe('conflicted');
      expect(result.factIds).toContain(vanishedFactId.toString());
      // Three ids named, two citable — and every emitted citation carries a real hash.
      expect(result.citations).toHaveLength(2);
      expect(result.citations.every((citation) => citation.sha256.length === 64)).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(vanishedFactId.toString()),
      );
    });
  });

  describe('listCells', () => {
    it('resolves entity to its canonical name and anchors the group-key regex to it', async () => {
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([{ docs: [], count: [] }]);

      await service.listCells(TENANT_ID, { entity: 'north gate plaza' });

      const [pipeline] = mockExtractedFactModel.aggregate.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      const match = pipeline[0].$match as Record<string, unknown>;
      expect(match.groupKeyNormalized).toEqual({ $regex: '^northgate plaza::' });
    });

    it('adds measure and period filters to the $match stage when given', async () => {
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([{ docs: [], count: [] }]);

      await service.listCells(TENANT_ID, { measure: 'cap_rate', period: 'March 2025' });

      const [pipeline] = mockExtractedFactModel.aggregate.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      expect(pipeline[0].$match).toEqual(
        expect.objectContaining({
          'factKey.metric': 'cap_rate',
          'factKey.period': '2025-03',
        }),
      );
    });

    it('defaults the sort to entity ascending, and honors an explicit sort field', async () => {
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([{ docs: [], count: [] }]);

      await service.listCells(TENANT_ID, {});

      const [defaultPipeline] = mockExtractedFactModel.aggregate.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      expect(defaultPipeline[2]).toEqual({ $sort: { entity: 1 } });

      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([{ docs: [], count: [] }]);

      await service.listCells(TENANT_ID, { sort: 'measure', sortDir: 'desc' });

      const [customPipeline] = mockExtractedFactModel.aggregate.mock.calls[1] as [
        Record<string, unknown>[],
      ];
      expect(customPipeline[2]).toEqual({ $sort: { measure: -1 } });
    });

    it('pages through $facet when no state filter is given, resolving only the page', async () => {
      const measureDef = buildMeasureDefinition();
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([measureDef]);
      const fact = buildFact();
      const group = {
        _id: fact.groupKeyNormalized,
        entity: fact.factKey.entity,
        measure: fact.factKey.metric,
        period: fact.factKey.period,
        factIds: [fact._id],
      };
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([
        { docs: [group], count: [{ count: 1 }] },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([fact]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockDocumentModel.find.mockResolvedValueOnce([]);

      const result = await service.listCells(TENANT_ID, {});

      expect(result.count).toBe(1);
      expect(result.docs).toEqual([
        expect.objectContaining({
          entity: 'Northgate Plaza',
          measure: 'cap_rate',
          state: 'unknown',
        }),
      ]);
    });

    // The page's facts are bucketed by group key before resolution. A cell holding more than one
    // fact is the ordinary case — two sources agreeing, or disagreeing — so the second fact must
    // join the existing bucket rather than replace it; dropping it would silently turn a
    // disagreement into a settled single value.
    it('buckets every fact of a multi-fact cell into one group', async () => {
      const measureDef = buildMeasureDefinition();
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([measureDef]);
      const factA = buildFact({ _id: new Types.ObjectId() });
      const factB = buildFact({ _id: new Types.ObjectId() });
      const group = {
        _id: factA.groupKeyNormalized,
        entity: factA.factKey.entity,
        measure: factA.factKey.metric,
        period: factA.factKey.period,
        factIds: [factA._id, factB._id],
      };
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([
        { docs: [group], count: [{ count: 1 }] },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([factA, factB]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      // A document apiece: two versions of ONE document would make the older one superseded and
      // drop it from the active set, which is a different rule than the bucketing under test.
      const documentIdA = new Types.ObjectId();
      const documentIdB = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        lifecycleVersionRow(factA.documentVersionId, documentIdA, 'a'.repeat(64)),
        lifecycleVersionRow(factB.documentVersionId, documentIdB, 'b'.repeat(64)),
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentIdA, currentVersionId: factA.documentVersionId },
        { _id: documentIdB, currentVersionId: factB.documentVersionId },
      ]);

      const result = await service.listCells(TENANT_ID, {});

      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
      // Both facts reached the same cell: they agree, so the cell settles rather than conflicting.
      expect(result.docs[0].factIds).toHaveLength(2);
      expect(result.docs[0].state).toBe('single');
    });

    it('materialises every matching group, resolves it, then filters and pages by state', async () => {
      const measureDef = buildMeasureDefinition();
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([measureDef]);
      const factSingle = buildFact({ _id: new Types.ObjectId() });
      const factUnknown = buildFact({
        _id: new Types.ObjectId(),
        factKey: { entity: 'Other Plaza', metric: 'cap_rate', period: '2025-03' },
        groupKeyNormalized: 'other plaza::cap_rate::2025-03',
      });
      const groups = [
        {
          _id: factSingle.groupKeyNormalized,
          entity: factSingle.factKey.entity,
          measure: factSingle.factKey.metric,
          period: factSingle.factKey.period,
          factIds: [factSingle._id],
        },
        {
          _id: factUnknown.groupKeyNormalized,
          entity: factUnknown.factKey.entity,
          measure: factUnknown.factKey.metric,
          period: factUnknown.factKey.period,
          factIds: [factUnknown._id],
        },
      ];
      // No $facet here — the state-filter path aggregates every group directly.
      mockExtractedFactModel.aggregate.mockResolvedValueOnce(groups);
      mockExtractedFactModel.find.mockResolvedValueOnce([factSingle, factUnknown]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      const documentId = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        lifecycleVersionRow(factSingle.documentVersionId, documentId, 'b'.repeat(64)),
        lifecycleVersionRow(factUnknown.documentVersionId, documentId, 'c'.repeat(64)),
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentId, currentVersionId: factSingle.documentVersionId },
      ]);

      const result = await service.listCells(TENANT_ID, { state: 'single' });

      expect(result.docs).toEqual([
        expect.objectContaining({ entity: 'Northgate Plaza', state: 'single' }),
      ]);
      expect(result.count).toBe(1);
      const [pipeline] = mockExtractedFactModel.aggregate.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      expect(pipeline).toHaveLength(3);
      expect(pipeline.some((stage) => '$facet' in stage)).toBe(false);
    });

    it('skips a group whose measure names no confirmed definition, with a warn', async () => {
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);
      const fact = buildFact({
        factKey: { entity: 'Northgate Plaza', metric: 'no_such_measure', period: '2025-03' },
      });
      const group = {
        _id: fact.groupKeyNormalized,
        entity: fact.factKey.entity,
        measure: 'no_such_measure',
        period: fact.factKey.period,
        factIds: [fact._id],
      };
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([
        { docs: [group], count: [{ count: 1 }] },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([fact]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockDocumentModel.find.mockResolvedValueOnce([]);

      const result = await service.listCells(TENANT_ID, {});

      expect(result.docs).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('no_such_measure'));
    });

    it('returns no results and runs no batch queries when a page has no groups', async () => {
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([]);
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([{ docs: [], count: [] }]);

      const result = await service.listCells(TENANT_ID, {});

      expect(result).toEqual({ docs: [], count: 0 });
      expect(mockConflictModel.find).not.toHaveBeenCalled();
    });

    // Every other listCells case hydrates a page with no conflicts at all, so the list view had
    // never actually shown a conflicted cell — only `resolveValue` had. A disagreement must be
    // visible in the list an operator scans, not only in the single-cell view they reach after
    // already suspecting something.
    it('reports a conflicted cell in the list view, not only on resolve', async () => {
      const measureDef = buildMeasureDefinition();
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([measureDef]);
      const factLow = buildFact({ _id: new Types.ObjectId() });
      const factHigh = buildFact({
        _id: new Types.ObjectId(),
        value: { amount: 6.1, unit: 'percent' },
      });
      const conflict = buildConflict({ factIds: [factLow._id, factHigh._id] });
      const group = {
        _id: factLow.groupKeyNormalized,
        entity: factLow.factKey.entity,
        measure: factLow.factKey.metric,
        period: factLow.factKey.period,
        factIds: [factLow._id, factHigh._id],
      };
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([
        { docs: [group], count: [{ count: 1 }] },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([factLow, factHigh]);
      mockConflictModel.find.mockResolvedValueOnce([conflict]);
      const documentIdLow = new Types.ObjectId();
      const documentIdHigh = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        lifecycleVersionRow(factLow.documentVersionId, documentIdLow, 'c'.repeat(64)),
        lifecycleVersionRow(factHigh.documentVersionId, documentIdHigh, 'd'.repeat(64)),
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentIdLow, currentVersionId: factLow.documentVersionId },
        { _id: documentIdHigh, currentVersionId: factHigh.documentVersionId },
      ]);

      const result = await service.listCells(TENANT_ID, {});

      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].state).toBe('conflicted');
      expect(result.docs[0].conflictId).toBe(conflict._id.toString());
      // No value: the list refuses to show a number the sources have not agreed on.
      expect(result.docs[0].value).toBeUndefined();
    });

    // `$facet` yields one wrapper document, but an aggregation can return nothing at all. Reading
    // `docs` off `undefined` would throw a 500 on what is really an empty ledger.
    it('returns an empty page when the aggregation yields no facet document at all', async () => {
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([
        buildMeasureDefinition(),
      ]);
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([]);

      const result = await service.listCells(TENANT_ID, {});

      expect(result).toEqual({ docs: [], count: 0 });
    });

    // A group the aggregation named but whose facts the follow-up query did not return — a fact
    // deleted between the two round trips. The cell resolves to `unknown` rather than throwing:
    // the ledger's job is to say what it knows, and here it knows nothing.
    it('resolves a group whose facts the batch query did not return', async () => {
      const measureDef = buildMeasureDefinition();
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce([measureDef]);
      const fact = buildFact();
      const group = {
        _id: fact.groupKeyNormalized,
        entity: fact.factKey.entity,
        measure: fact.factKey.metric,
        period: fact.factKey.period,
        factIds: [fact._id],
      };
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([
        { docs: [group], count: [{ count: 1 }] },
      ]);
      // The group is named, but the fact is gone by the time the page is hydrated.
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockConflictModel.find.mockResolvedValueOnce([]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockDocumentModel.find.mockResolvedValueOnce([]);

      const result = await service.listCells(TENANT_ID, {});

      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].state).toBe('unknown');
      expect(result.docs[0].factIds).toEqual([]);
    });
  });

  describe('listFacts', () => {
    it('derives the same group key as resolveValue and defaults an absent period to undated', async () => {
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockMeasuresService.findBySlug.mockResolvedValueOnce(null);

      await service.listFacts(TENANT_ID, { entity: 'north gate plaza', measure: 'cap_rate' });

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId: TENANT_ID, groupKeyNormalized: 'northgate plaza::cap_rate::undated' },
        null,
        expect.objectContaining({ sort: { createdAt: -1 } }),
      );
    });

    it('computes canonicalAmount from the measure definition when the measure resolves', async () => {
      const measureDoc = buildMeasureDoc();
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      const fact = buildFact();
      mockExtractedFactModel.find.mockResolvedValueOnce([fact]);
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(1);
      mockMeasuresService.findBySlug.mockResolvedValueOnce(measureDoc);
      const documentId = new Types.ObjectId();
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        lifecycleVersionRow(fact.documentVersionId, documentId, 'd'.repeat(64)),
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        { _id: documentId, currentVersionId: fact.documentVersionId },
      ]);

      const result = await service.listFacts(TENANT_ID, {
        entity: 'Northgate Plaza',
        measure: 'cap_rate',
      });

      expect(result.count).toBe(1);
      expect(result.docs[0].canonicalAmount).toBeCloseTo(0.0525);
      expect(result.docs[0].measureStatus).toBe('confirmed');
      expect(result.docs[0].citation).toEqual(
        expect.objectContaining({ sha256: 'd'.repeat(64), withdrawn: false }),
      );
    });

    it('leaves canonicalAmount and citation absent when neither the measure nor the lifecycle resolves', async () => {
      mockCanonicalEntityService.resolveMany.mockResolvedValueOnce([
        { name: 'Northgate Plaza', matched: true },
      ]);
      const fact = buildFact();
      mockExtractedFactModel.find.mockResolvedValueOnce([fact]);
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(1);
      mockMeasuresService.findBySlug.mockResolvedValueOnce(null);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockDocumentModel.find.mockResolvedValueOnce([]);

      const result = await service.listFacts(TENANT_ID, {
        entity: 'Northgate Plaza',
        measure: 'cap_rate',
      });

      expect(result.docs[0].canonicalAmount).toBeUndefined();
      expect(result.docs[0].citation).toBeUndefined();
      expect(result.docs[0].withdrawn).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('listEntities', () => {
    it('returns the paged docs and count from the facet result', async () => {
      const row = { entity: 'Northgate Plaza', factCount: 3, measureCount: 2 };
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([
        { docs: [row], count: [{ count: 1 }] },
      ]);

      const result = await service.listEntities(TENANT_ID, {});

      expect(result).toEqual({ docs: [row], count: 1 });
      const [pipeline] = mockExtractedFactModel.aggregate.mock.calls[0] as [
        Record<string, unknown>[],
      ];
      expect(pipeline[0]).toEqual({ $match: { tenantId: TENANT_ID, measureStatus: 'confirmed' } });
    });

    it('defaults to an empty page when the facet returns nothing', async () => {
      mockExtractedFactModel.aggregate.mockResolvedValueOnce([]);

      const result = await service.listEntities(TENANT_ID, {});

      expect(result).toEqual({ docs: [], count: 0 });
    });
  });

  describe('listMeasures', () => {
    it('delegates to MeasuresService.listConfirmedDefinitions', async () => {
      const definitions = [buildMeasureDefinition()];
      mockMeasuresService.listConfirmedDefinitions.mockResolvedValueOnce(definitions);

      const result = await service.listMeasures(TENANT_ID);

      expect(mockMeasuresService.listConfirmedDefinitions).toHaveBeenCalledWith(TENANT_ID);
      expect(result).toBe(definitions);
    });
  });
});
