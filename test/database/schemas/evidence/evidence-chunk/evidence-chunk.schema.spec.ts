import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  EvidenceChunk,
  EvidenceChunkSchema,
} from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { EvidenceLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';

jest.setTimeout(60000);

const locatorFixtures: Record<EvidenceLocator['kind'], EvidenceLocator> = {
  'pdf-page': { kind: 'pdf-page', extractorVersion: 'pdf-extractor@1.0.0', page: 3 },
  'docx-paragraph': {
    kind: 'docx-paragraph',
    extractorVersion: 'docx-extractor@1.0.0',
    paragraphIndex: 12,
    headingPath: ['Section 2'],
  },
  'xlsx-region': {
    kind: 'xlsx-region',
    extractorVersion: 'xlsx-extractor@1.0.0',
    sheetName: 'Q3 Revenue',
    range: 'A1:C10',
  },
  'xlsx-cell': {
    kind: 'xlsx-cell',
    extractorVersion: 'xlsx-extractor@1.0.0',
    sheetName: 'Q3 Revenue',
    cell: 'B7',
  },
};

const buildChunkInput = (locator: EvidenceLocator) => ({
  documentId: new mongoose.Types.ObjectId(),
  documentVersionId: new mongoose.Types.ObjectId(),
  text: 'Revenue grew 12% year over year.',
  tokenCount: 8,
  embedding: [0.1, 0.2, 0.3],
  locator,
});

describe('EvidenceChunk schema', () => {
  describe('validation (offline — no database connection)', () => {
    const EvidenceChunkModel = mongoose.model<EvidenceChunk>(
      'EvidenceChunkValidationOnly',
      EvidenceChunkSchema,
    );

    it.each(Object.entries(locatorFixtures))(
      'accepts a %s locator and preserves its discriminant on read',
      (kind, locator) => {
        const chunk = new EvidenceChunkModel(buildChunkInput(locator));

        expect(chunk.validateSync()).toBeUndefined();
        expect(chunk.locator.kind).toBe(kind);
      },
    );

    it('requires documentId, documentVersionId, text, tokenCount, embedding, and locator', () => {
      const chunk = new EvidenceChunkModel({});

      const error = chunk.validateSync();

      expect(error?.errors.documentId).toBeDefined();
      expect(error?.errors.documentVersionId).toBeDefined();
      expect(error?.errors.text).toBeDefined();
      expect(error?.errors.tokenCount).toBeDefined();
      expect(error?.errors.embedding).toBeDefined();
      expect(error?.errors.locator).toBeDefined();
    });

    it('defaults tenantId to DEFAULT_TENANT_ID', () => {
      const chunk = new EvidenceChunkModel(buildChunkInput(locatorFixtures['pdf-page']));

      expect(chunk.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let EvidenceChunkModel: Model<EvidenceChunk>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      EvidenceChunkModel = connection.model<EvidenceChunk>(EvidenceChunk.name, EvidenceChunkSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it.each(Object.entries(locatorFixtures))(
      'persists and rehydrates a chunk with a %s locator',
      async (kind, locator) => {
        const created = await EvidenceChunkModel.create(buildChunkInput(locator));

        const found = await EvidenceChunkModel.findById(created._id).lean();

        expect(found?.locator).toMatchObject({ kind, extractorVersion: locator.extractorVersion });
        expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
      },
    );
  });
});
