import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';

jest.setTimeout(60000);

const buildFactInput = () => ({
  tenantId: 'tenant-a',
  factKey: { entity: 'Acme Corp', metric: 'revenue', period: 'Q3-2025' },
  // Required, not optional: the incremental conflict scan queries facts by
  // `{tenantId, groupKeyNormalized}`, so a fact persisted without it is invisible to every keyed
  // scan. Both production write paths derive it with `groupKey()`; this fixture mirrors that.
  groupKeyNormalized: 'acme corp::revenue::Q3-2025',
  value: { amount: 12_000_000, unit: 'usd' },
  rawText: 'Revenue for Q3 2025 was $12.0M',
  confidence: 0.92,
  extractionMethod: 'llm' as const,
  packId: 'cre',
  packVersion: 1,
  measureId: new mongoose.Types.ObjectId(),
  measureVersion: 1,
  measureStatus: 'confirmed' as const,
  // Content-addressed (`computeChunkId`), not an ObjectId — see `EvidenceChunk._id`'s doc comment.
  chunkId: 'chunk-b7',
  documentVersionId: new mongoose.Types.ObjectId(),
  locator: {
    kind: 'xlsx-cell' as const,
    extractorVersion: 'xlsx-extractor@1.0.0',
    sheetName: 'Q3',
    cell: 'B7',
  },
});

describe('ExtractedFact schema', () => {
  describe('validation (offline — no database connection)', () => {
    const ExtractedFactModel = mongoose.model<ExtractedFact>(
      'ExtractedFactValidationOnly',
      ExtractedFactSchema,
    );

    it('requires factKey, value, rawText, confidence, extractionMethod, packId, packVersion, chunkId, and locator', () => {
      const fact = new ExtractedFactModel({});

      const error = fact.validateSync();

      expect(error?.errors.factKey).toBeDefined();
      expect(error?.errors.value).toBeDefined();
      expect(error?.errors.rawText).toBeDefined();
      expect(error?.errors.confidence).toBeDefined();
      expect(error?.errors.extractionMethod).toBeDefined();
      expect(error?.errors.packId).toBeDefined();
      expect(error?.errors.packVersion).toBeDefined();
      expect(error?.errors.chunkId).toBeDefined();
      expect(error?.errors.locator).toBeDefined();
      expect(error?.errors.tenantId).toBeDefined();
    });

    it('rejects an extractionMethod outside llm/regex/manual', () => {
      const fact = new ExtractedFactModel({
        ...buildFactInput(),
        extractionMethod: 'ocr-guess',
      });

      const error = fact.validateSync();

      expect(error?.errors.extractionMethod).toBeDefined();
    });

    it('rejects a confidence outside [0, 1]', () => {
      const fact = new ExtractedFactModel({ ...buildFactInput(), confidence: 1.5 });

      const error = fact.validateSync();

      expect(error?.errors.confidence).toBeDefined();
    });

    it('passes validation with an explicit tenantId', () => {
      const fact = new ExtractedFactModel(buildFactInput());

      expect(fact.tenantId).toBe('tenant-a');
      expect(fact.validateSync()).toBeUndefined();
    });

    it('leaves observedAt undefined when not supplied', () => {
      const fact = new ExtractedFactModel(buildFactInput());

      expect(fact.observedAt).toBeUndefined();
      expect(fact.validateSync()).toBeUndefined();
    });

    it('accepts an explicit observedAt', () => {
      const observedAt = new Date('2026-06-15T00:00:00.000Z');
      const fact = new ExtractedFactModel({ ...buildFactInput(), observedAt });

      expect(fact.observedAt).toEqual(observedAt);
      expect(fact.validateSync()).toBeUndefined();
    });

    it.each(['measureId', 'measureVersion', 'measureStatus'] as const)('requires %s', (field) => {
      const input = { ...buildFactInput() };
      delete (input as Record<string, unknown>)[field];
      const fact = new ExtractedFactModel(input);

      const error = fact.validateSync();

      expect(error?.errors[field]).toBeDefined();
    });

    it('rejects a measureStatus outside proposed/confirmed', () => {
      const fact = new ExtractedFactModel({
        ...buildFactInput(),
        measureStatus: 'rejected',
      });

      const error = fact.validateSync();

      expect(error?.errors.measureStatus).toBeDefined();
    });

    it('leaves periodStart and periodEnd undefined when not supplied', () => {
      const fact = new ExtractedFactModel(buildFactInput());

      expect(fact.periodStart).toBeUndefined();
      expect(fact.periodEnd).toBeUndefined();
      expect(fact.validateSync()).toBeUndefined();
    });

    it('accepts explicit periodStart and periodEnd', () => {
      const periodStart = new Date('2025-07-01T00:00:00.000Z');
      const periodEnd = new Date('2025-09-30T00:00:00.000Z');
      const fact = new ExtractedFactModel({ ...buildFactInput(), periodStart, periodEnd });

      expect(fact.periodStart).toEqual(periodStart);
      expect(fact.periodEnd).toEqual(periodEnd);
      expect(fact.validateSync()).toBeUndefined();
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let ExtractedFactModel: Model<ExtractedFact>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      ExtractedFactModel = connection.model<ExtractedFact>(ExtractedFact.name, ExtractedFactSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a fact with its normalized value and locator', async () => {
      const created = await ExtractedFactModel.create(buildFactInput());

      const found = await ExtractedFactModel.findById(created._id);

      // Assert against the plain object: `factKey` and `value` rehydrate as Mongoose
      // subdocuments, and jest's structural equality walks their prototype, tripping over the
      // strict-mode `caller`/`arguments` accessors on the internal functions it finds there.
      const plain = found?.toObject();

      expect(plain?.factKey).toEqual({
        entity: 'Acme Corp',
        metric: 'revenue',
        period: 'Q3-2025',
      });
      expect(plain?.value).toEqual({ amount: 12_000_000, unit: 'usd' });
      expect(found?.tenantId).toBe('tenant-a');
      expect(found?.observedAt).toBeUndefined();
    });

    it('persists and rehydrates an explicit observedAt, distinct from factKey.period', async () => {
      const observedAt = new Date('2026-06-15T00:00:00.000Z');

      const created = await ExtractedFactModel.create({ ...buildFactInput(), observedAt });

      const found = await ExtractedFactModel.findById(created._id);

      expect(found?.observedAt).toEqual(observedAt);
      expect(found?.factKey.period).toBe('Q3-2025');
    });
  });
});
