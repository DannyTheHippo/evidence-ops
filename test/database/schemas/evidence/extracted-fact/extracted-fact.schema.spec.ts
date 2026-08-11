import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';

jest.setTimeout(60000);

const buildFactInput = () => ({
  factKey: { entity: 'Acme Corp', metric: 'revenue', period: 'Q3-2025' },
  value: { amount: 12_000_000, unit: 'usd' },
  rawText: 'Revenue for Q3 2025 was $12.0M',
  confidence: 0.92,
  extractionMethod: 'llm' as const,
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

    it('requires factKey, value, rawText, confidence, extractionMethod, chunkId, and locator', () => {
      const fact = new ExtractedFactModel({});

      const error = fact.validateSync();

      expect(error?.errors.factKey).toBeDefined();
      expect(error?.errors.value).toBeDefined();
      expect(error?.errors.rawText).toBeDefined();
      expect(error?.errors.confidence).toBeDefined();
      expect(error?.errors.extractionMethod).toBeDefined();
      expect(error?.errors.chunkId).toBeDefined();
      expect(error?.errors.locator).toBeDefined();
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

    it('defaults tenantId to DEFAULT_TENANT_ID', () => {
      const fact = new ExtractedFactModel(buildFactInput());

      expect(fact.tenantId).toBe(DEFAULT_TENANT_ID);
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
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
