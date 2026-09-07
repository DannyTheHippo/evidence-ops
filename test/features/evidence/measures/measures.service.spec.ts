import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { Measure } from '../../../../src/database/schemas/evidence/measure/measure.schema';
import type { HeaderMeasureProposal } from '../../../../src/features/evidence/measures/infer-header-measure';
import {
  InvalidMeasureDefinitionException,
  MeasureNotConfirmedException,
  MeasureNotFoundException,
  MeasureNotProposedException,
} from '../../../../src/features/evidence/measures/exceptions/measures.exception';
import { MeasuresService } from '../../../../src/features/evidence/measures/measures.service';
import { ConflictsService } from '../../../../src/features/evidence/conflicts/conflicts.service';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

const DEFAULT_TENANT_ID = 'acme-corp';
const VALID_ID = '65f1c2e4a1b2c3d4e5f6a7b8';

describe('MeasuresService', () => {
  let service: MeasuresService;

  const mockMeasureModel = getMockModel();
  const mockExtractedFactModel = getMockModel();
  const mockConflictsService = { scanForConflicts: jest.fn() };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const buildMeasureDoc = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    tenantId: DEFAULT_TENANT_ID,
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
    proposedFrom: [] as {
      documentVersionId: Types.ObjectId;
      locator: unknown;
      headerText: string;
    }[],
    version: 1,
    // Optional on `Measure` and absent from a seed row, but declared here so a spec can assert an
    // edit landed on them — the same reason `confirmedBy` and the rejection fields are declared.
    authorityOrder: undefined as string[] | undefined,
    stalenessWindowMs: undefined as number | undefined,
    confirmedBy: undefined as string | undefined,
    confirmedAt: undefined as Date | undefined,
    rejectedBy: undefined as string | undefined,
    rejectedAt: undefined as Date | undefined,
    rejectedReason: undefined as string | undefined,
    lastRescan: undefined as Record<string, unknown> | undefined,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const buildProposal = (
    overrides: Partial<HeaderMeasureProposal> = {},
  ): HeaderMeasureProposal => ({
    slug: 'walkability_score',
    label: 'Walkability Score',
    aliases: ['Walkability Score'],
    valueType: 'count',
    canonicalUnit: 'count',
    units: [{ id: 'count', toCanonicalFactor: 1 }],
    toleranceKind: 'absolute',
    tolerance: 0,
    headerText: 'Walkability Score',
    headerLocator: { kind: 'xlsx-cell', sheetName: 'Sheet1', cell: 'B2', extractorVersion: 'v1' },
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MeasuresService,
        { provide: getModelToken(Measure.name), useValue: mockMeasureModel },
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: ConflictsService, useValue: mockConflictsService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<MeasuresService>(MeasuresService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('listForTenant', () => {
    it('filters by tenant only when no status is given, applying the pagination defaults', async () => {
      mockMeasureModel.find.mockResolvedValueOnce([]);
      mockMeasureModel.countDocuments.mockResolvedValueOnce(0);

      const result = await service.listForTenant(DEFAULT_TENANT_ID, {});

      expect(mockMeasureModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID },
        null,
        expect.objectContaining({ skip: 0, limit: 20 }),
      );
      expect(mockMeasureModel.countDocuments).toHaveBeenCalledWith({ tenantId: DEFAULT_TENANT_ID });
      expect(result).toEqual({ docs: [], count: 0 });
    });

    it('adds a status filter and honors explicit skip/limit', async () => {
      const docs = [buildMeasureDoc()];
      mockMeasureModel.find.mockResolvedValueOnce(docs);
      mockMeasureModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.listForTenant(DEFAULT_TENANT_ID, {
        status: 'proposed',
        skip: 5,
        limit: 10,
      });

      expect(mockMeasureModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, status: 'proposed' },
        null,
        expect.objectContaining({ skip: 5, limit: 10 }),
      );
      expect(result).toEqual({ docs, count: 1 });
    });
  });

  describe('listConfirmedDefinitions', () => {
    it('orders the confirmed rows for extraction', async () => {
      const rows = [
        buildMeasureDoc({ slug: 'sale_price', origin: 'seed' }),
        buildMeasureDoc({ slug: 'cap_rate', origin: 'seed' }),
      ];
      mockMeasureModel.find.mockResolvedValueOnce(rows);

      const definitions = await service.listConfirmedDefinitions(DEFAULT_TENANT_ID);

      expect(mockMeasureModel.find).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        status: 'confirmed',
      });
      // `cap_rate` precedes `sale_price` in METRIC_IDS, so orderForExtraction reorders the rows.
      expect(definitions.map((def) => def.id)).toEqual(['cap_rate', 'sale_price']);
    });
  });

  describe('loadExtractionContext', () => {
    it('partitions confirmed, proposed and rejected rows in one query', async () => {
      const confirmedDoc = buildMeasureDoc({
        slug: 'cap_rate',
        status: 'confirmed',
        origin: 'seed',
      });
      const proposedDoc = buildMeasureDoc({
        slug: 'walkability_score',
        status: 'proposed',
        origin: 'header',
      });
      const rejectedDoc = buildMeasureDoc({ slug: 'notes', status: 'rejected', origin: 'header' });
      mockMeasureModel.find.mockResolvedValueOnce([confirmedDoc, proposedDoc, rejectedDoc]);

      const context = await service.loadExtractionContext(DEFAULT_TENANT_ID);

      expect(mockMeasureModel.find).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        status: { $in: ['confirmed', 'proposed', 'rejected'] },
      });
      expect(context.confirmed.map((def) => def.id)).toEqual(['cap_rate']);
      expect(context.matchable.map((def) => def.id)).toEqual(['cap_rate', 'walkability_score']);
      expect(context.rejectedSlugs).toEqual(new Set(['notes']));
    });
  });

  describe('findBySlug', () => {
    it('reads any status by tenant and slug', async () => {
      const doc = buildMeasureDoc({ status: 'rejected' });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      const result = await service.findBySlug('cap_rate', DEFAULT_TENANT_ID);

      expect(mockMeasureModel.findOne).toHaveBeenCalledWith({
        tenantId: DEFAULT_TENANT_ID,
        slug: 'cap_rate',
      });
      expect(result).toBe(doc);
    });
  });

  describe('proposeMany', () => {
    const documentVersionId = new Types.ObjectId();

    it('stamps a confirmed slug from the existing row, without saving it', async () => {
      const doc = buildMeasureDoc({ status: 'confirmed', version: 3 });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [
        buildProposal({ slug: doc.slug }),
      ]);

      expect(stamps.get(doc.slug)).toEqual({
        measureId: doc._id,
        measureVersion: 3,
        measureStatus: 'confirmed',
      });
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('mints no stamp for a rejected slug', async () => {
      const doc = buildMeasureDoc({ status: 'rejected' });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [
        buildProposal({ slug: doc.slug }),
      ]);

      expect(stamps.has(doc.slug)).toBe(false);
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('records new evidence on a proposed row below the cap and stamps it proposed', async () => {
      const doc = buildMeasureDoc({ status: 'proposed', proposedFrom: [] });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);
      const proposal = buildProposal({ slug: doc.slug });

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [proposal]);

      expect(doc.proposedFrom).toEqual([
        { documentVersionId, locator: proposal.headerLocator, headerText: proposal.headerText },
      ]);
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(stamps.get(doc.slug)).toEqual({
        measureId: doc._id,
        measureVersion: doc.version,
        measureStatus: 'proposed',
      });
    });

    it('does not re-record evidence already carrying the same documentVersionId', async () => {
      const doc = buildMeasureDoc({
        status: 'proposed',
        proposedFrom: [
          { documentVersionId, locator: buildProposal().headerLocator, headerText: 'existing' },
        ],
      });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [
        buildProposal({ slug: doc.slug }),
      ]);

      expect(doc.proposedFrom).toHaveLength(1);
      expect(doc.save).not.toHaveBeenCalled();
      expect(stamps.get(doc.slug)?.measureStatus).toBe('proposed');
    });

    it('does not push past the evidence cap, but still stamps proposed', async () => {
      const proposedFrom = Array.from({ length: 50 }, () => ({
        documentVersionId: new Types.ObjectId(),
        locator: buildProposal().headerLocator,
        headerText: 'prior evidence',
      }));
      const doc = buildMeasureDoc({ status: 'proposed', proposedFrom });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [
        buildProposal({ slug: doc.slug }),
      ]);

      expect(doc.proposedFrom).toHaveLength(50);
      expect(doc.save).not.toHaveBeenCalled();
      expect(stamps.get(doc.slug)?.measureStatus).toBe('proposed');
    });

    it('creates a proposed row for a slug no measure yet names', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(null);
      const created = buildMeasureDoc({ status: 'proposed', version: 1 });
      mockMeasureModel.create.mockResolvedValueOnce(created);
      const proposal = buildProposal({ slug: created.slug });

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [proposal]);

      expect(mockMeasureModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: DEFAULT_TENANT_ID,
          slug: proposal.slug,
          status: 'proposed',
          origin: 'header',
          version: 1,
          proposedFrom: [
            { documentVersionId, locator: proposal.headerLocator, headerText: proposal.headerText },
          ],
        }),
      );
      expect(stamps.get(proposal.slug)).toEqual({
        measureId: created._id,
        measureVersion: 1,
        measureStatus: 'proposed',
      });
    });

    it('rethrows a create error that is not a duplicate key', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(null);
      const error = new Error('connection reset');
      mockMeasureModel.create.mockRejectedValueOnce(error);

      await expect(
        service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [buildProposal()]),
      ).rejects.toBe(error);
    });

    it('re-reads and stamps from the winning row after a concurrent-insert race', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(null);
      mockMeasureModel.create.mockRejectedValueOnce({ code: 11000 });
      const winner = buildMeasureDoc({ status: 'confirmed', version: 2 });
      mockMeasureModel.findOne.mockResolvedValueOnce(winner);

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [
        buildProposal({ slug: winner.slug }),
      ]);

      expect(mockMeasureModel.findOne).toHaveBeenCalledTimes(2);
      expect(stamps.get(winner.slug)).toEqual({
        measureId: winner._id,
        measureVersion: 2,
        measureStatus: 'confirmed',
      });
    });

    it('mints no stamp when the racing row cannot be re-read at all', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(null);
      mockMeasureModel.create.mockRejectedValueOnce({ code: 11000 });
      mockMeasureModel.findOne.mockResolvedValueOnce(null);

      const stamps = await service.proposeMany(DEFAULT_TENANT_ID, documentVersionId, [
        buildProposal(),
      ]);

      expect(stamps.size).toBe(0);
    });
  });

  describe('confirm', () => {
    const actorId = 'user-1';

    it('throws MeasureNotFoundException for a malformed id, without querying the model', async () => {
      await expect(
        service.confirm('not-an-object-id', DEFAULT_TENANT_ID, {}, actorId),
      ).rejects.toBeInstanceOf(MeasureNotFoundException);
      expect(mockMeasureModel.findOne).not.toHaveBeenCalled();
    });

    it('throws MeasureNotFoundException when no row matches the id and tenant', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.confirm(VALID_ID, DEFAULT_TENANT_ID, {}, actorId),
      ).rejects.toBeInstanceOf(MeasureNotFoundException);
    });

    it('throws MeasureNotProposedException when the row is not proposed', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(buildMeasureDoc({ status: 'confirmed' }));

      await expect(
        service.confirm(VALID_ID, DEFAULT_TENANT_ID, {}, actorId),
      ).rejects.toBeInstanceOf(MeasureNotProposedException);
    });

    it('rejects an edit that fails validation, before any save', async () => {
      const doc = buildMeasureDoc({ status: 'proposed', version: 1 });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      await expect(
        service.confirm(VALID_ID, DEFAULT_TENANT_ID, { units: [] }, actorId),
      ).rejects.toBeInstanceOf(InvalidMeasureDefinitionException);
      expect(doc.save).not.toHaveBeenCalled();
      expect(mockExtractedFactModel.updateMany).not.toHaveBeenCalled();
    });

    it('confirms, rescans and records a completed rescan on the row', async () => {
      const doc = buildMeasureDoc({ status: 'proposed', version: 1 });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);
      mockExtractedFactModel.updateMany.mockResolvedValueOnce({});
      const factKey = { entity: 'Northgate', metric: 'cap_rate', period: '2025-03' };
      mockExtractedFactModel.find.mockResolvedValueOnce([{ factKey }]);
      mockConflictsService.scanForConflicts.mockResolvedValueOnce({
        conflictsCreated: 2,
        skippedFactCount: 1,
      });

      const result = await service.confirm(
        VALID_ID,
        DEFAULT_TENANT_ID,
        { label: 'Cap Rate v2' },
        actorId,
      );

      expect(doc.status).toBe('confirmed');
      expect(doc.label).toBe('Cap Rate v2');
      expect(doc.version).toBe(2);
      expect(doc.confirmedBy).toBe(actorId);
      expect(doc.confirmedAt).toBeInstanceOf(Date);
      expect(mockExtractedFactModel.updateMany).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, measureId: doc._id },
        { $set: { measureStatus: 'confirmed' } },
      );
      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        { tenantId: DEFAULT_TENANT_ID, measureId: doc._id },
        { factKey: 1 },
      );
      expect(mockConflictsService.scanForConflicts).toHaveBeenCalledWith(DEFAULT_TENANT_ID, [
        factKey,
      ]);
      expect(doc.lastRescan).toEqual(
        expect.objectContaining({ status: 'completed', conflictsCreated: 2, skippedFactCount: 1 }),
      );
      expect(doc.save).toHaveBeenCalledTimes(2);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'measures.confirmed',
        actorId,
        subject: { entityType: 'Measure', entityId: doc._id.toString() },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result).toBe(doc);
    });

    it('still confirms when the rescan itself throws, recording the failure on the row', async () => {
      const doc = buildMeasureDoc({ status: 'proposed', version: 1 });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);
      mockExtractedFactModel.updateMany.mockResolvedValueOnce({});
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      const scanError = new Error('scan blew up');
      mockConflictsService.scanForConflicts.mockRejectedValueOnce(scanError);

      const result = await service.confirm(VALID_ID, DEFAULT_TENANT_ID, {}, actorId);

      expect(doc.status).toBe('confirmed');
      expect(doc.lastRescan).toEqual(
        expect.objectContaining({ status: 'failed', error: String(scanError) }),
      );
      expect(doc.save).toHaveBeenCalledTimes(2);
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'measures.confirmed' }),
      );
      expect(result).toBe(doc);
    });
  });

  describe('reject', () => {
    const actorId = 'user-1';

    it('throws MeasureNotFoundException for a malformed id', async () => {
      await expect(
        service.reject('not-an-object-id', DEFAULT_TENANT_ID, undefined, actorId),
      ).rejects.toBeInstanceOf(MeasureNotFoundException);
    });

    it('throws MeasureNotFoundException when no row matches', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.reject(VALID_ID, DEFAULT_TENANT_ID, undefined, actorId),
      ).rejects.toBeInstanceOf(MeasureNotFoundException);
    });

    it('throws MeasureNotProposedException when the row is not proposed', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(buildMeasureDoc({ status: 'rejected' }));

      await expect(
        service.reject(VALID_ID, DEFAULT_TENANT_ID, 'no longer needed', actorId),
      ).rejects.toBeInstanceOf(MeasureNotProposedException);
    });

    it('rejects a proposed row, leaving facts untouched', async () => {
      const doc = buildMeasureDoc({ status: 'proposed' });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      const result = await service.reject(
        VALID_ID,
        DEFAULT_TENANT_ID,
        'duplicate of cap_rate',
        actorId,
      );

      expect(doc.status).toBe('rejected');
      expect(doc.rejectedBy).toBe(actorId);
      expect(doc.rejectedAt).toBeInstanceOf(Date);
      expect(doc.rejectedReason).toBe('duplicate of cap_rate');
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(mockExtractedFactModel.updateMany).not.toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'measures.rejected',
        actorId,
        subject: { entityType: 'Measure', entityId: doc._id.toString() },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result).toBe(doc);
    });
  });

  describe('update', () => {
    const actorId = 'user-1';

    it('throws MeasureNotFoundException for a malformed id', async () => {
      await expect(
        service.update('not-an-object-id', DEFAULT_TENANT_ID, {}, actorId),
      ).rejects.toBeInstanceOf(MeasureNotFoundException);
    });

    it('throws MeasureNotFoundException when no row matches', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(null);

      await expect(service.update(VALID_ID, DEFAULT_TENANT_ID, {}, actorId)).rejects.toBeInstanceOf(
        MeasureNotFoundException,
      );
    });

    it('throws MeasureNotConfirmedException when the row is not confirmed', async () => {
      mockMeasureModel.findOne.mockResolvedValueOnce(buildMeasureDoc({ status: 'proposed' }));

      await expect(service.update(VALID_ID, DEFAULT_TENANT_ID, {}, actorId)).rejects.toBeInstanceOf(
        MeasureNotConfirmedException,
      );
    });

    it('rejects an edit that fails validation, before any save', async () => {
      const doc = buildMeasureDoc({ status: 'confirmed' });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);

      await expect(
        service.update(VALID_ID, DEFAULT_TENANT_ID, { tolerance: -1 }, actorId),
      ).rejects.toBeInstanceOf(InvalidMeasureDefinitionException);
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('bumps the version and rescans a confirmed row', async () => {
      const doc = buildMeasureDoc({ status: 'confirmed', version: 4 });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);
      mockExtractedFactModel.updateMany.mockResolvedValueOnce({});
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockConflictsService.scanForConflicts.mockResolvedValueOnce({
        conflictsCreated: 0,
        skippedFactCount: 0,
      });

      const result = await service.update(
        VALID_ID,
        DEFAULT_TENANT_ID,
        { tolerance: 0.005 },
        actorId,
      );

      expect(doc.tolerance).toBe(0.005);
      expect(doc.version).toBe(5);
      expect(doc.save).toHaveBeenCalledTimes(2);
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'measures.updated',
        actorId,
        subject: { entityType: 'Measure', entityId: doc._id.toString() },
        tenantId: DEFAULT_TENANT_ID,
      });
      expect(result).toBe(doc);
    });

    // Every editable field, in one call. `applyEdits` assigns each behind its own
    // `!== undefined` guard, so a spec that only ever edits `tolerance` leaves the other eight
    // assignments unexecuted — and an edit silently dropped by a mistyped guard would look
    // exactly like an edit the caller never sent.
    it('applies every editable field a caller supplies', async () => {
      const doc = buildMeasureDoc({ status: 'confirmed', version: 1 });
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);
      mockExtractedFactModel.updateMany.mockResolvedValueOnce({});
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockConflictsService.scanForConflicts.mockResolvedValueOnce({
        conflictsCreated: 0,
        skippedFactCount: 0,
      });

      await service.update(
        VALID_ID,
        DEFAULT_TENANT_ID,
        {
          label: 'Occupancy',
          aliases: ['Occupancy %', 'occupancy rate'],
          valueType: 'percentage',
          canonicalUnit: 'ratio',
          units: [
            { id: 'ratio', toCanonicalFactor: 1 },
            { id: 'percent', toCanonicalFactor: 0.01 },
          ],
          toleranceKind: 'absolute',
          tolerance: 0.02,
          authorityOrder: ['pm-export', 'spreadsheet'],
          stalenessWindowMs: 86_400_000,
        },
        actorId,
      );

      expect(doc.label).toBe('Occupancy');
      expect(doc.aliases).toEqual(['Occupancy %', 'occupancy rate']);
      expect(doc.valueType).toBe('percentage');
      expect(doc.canonicalUnit).toBe('ratio');
      expect(doc.units).toEqual([
        { id: 'ratio', toCanonicalFactor: 1 },
        { id: 'percent', toCanonicalFactor: 0.01 },
      ]);
      expect(doc.toleranceKind).toBe('absolute');
      expect(doc.tolerance).toBe(0.02);
      expect(doc.authorityOrder).toEqual(['pm-export', 'spreadsheet']);
      expect(doc.stalenessWindowMs).toBe(86_400_000);
    });

    // The mirror of the case above: an empty edit set is legal — `PATCH` with no fields still
    // bumps the version and rescans — and must leave every field exactly as it was.
    it('leaves every field untouched when the caller supplies no edits', async () => {
      const doc = buildMeasureDoc({ status: 'confirmed', version: 2 });
      const before = {
        label: doc.label,
        aliases: doc.aliases,
        valueType: doc.valueType,
        canonicalUnit: doc.canonicalUnit,
        toleranceKind: doc.toleranceKind,
        tolerance: doc.tolerance,
      };
      mockMeasureModel.findOne.mockResolvedValueOnce(doc);
      mockExtractedFactModel.updateMany.mockResolvedValueOnce({});
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockConflictsService.scanForConflicts.mockResolvedValueOnce({
        conflictsCreated: 0,
        skippedFactCount: 0,
      });

      await service.update(VALID_ID, DEFAULT_TENANT_ID, {}, actorId);

      expect(doc.label).toBe(before.label);
      expect(doc.aliases).toBe(before.aliases);
      expect(doc.valueType).toBe(before.valueType);
      expect(doc.canonicalUnit).toBe(before.canonicalUnit);
      expect(doc.toleranceKind).toBe(before.toleranceKind);
      expect(doc.tolerance).toBe(before.tolerance);
      expect(doc.version).toBe(3);
    });
  });
});
