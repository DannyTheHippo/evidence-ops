import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  Document,
  DocumentSchema,
} from '../../../../../src/database/schemas/evidence/document/document.schema';

// MongoMemoryServer boot (binary spin-up + replica init) regularly exceeds Jest's 5s default.
jest.setTimeout(60000);

describe('Document schema', () => {
  describe('validation (offline — no database connection)', () => {
    // Unconnected model: `validateSync` runs local schema validators only, no network needed.
    // Generic is the schema's own class (`Document`), matching what `SchemaFactory.createForClass`
    // produced — not the `HydratedDocument<WithTimestamps<...>>` alias, which the `.model()`
    // overloads do not structurally accept as a type argument.
    const DocumentModel = mongoose.model<Document>('DocumentValidationOnly', DocumentSchema);

    it('requires title, sourceKind, and mimeType', () => {
      const doc = new DocumentModel({});

      const error = doc.validateSync();

      expect(error?.errors.title).toBeDefined();
      expect(error?.errors.sourceKind).toBeDefined();
      expect(error?.errors.mimeType).toBeDefined();
    });

    it('rejects a sourceKind outside pdf/docx/xlsx', () => {
      const doc = new DocumentModel({
        title: 'Q3 Report',
        sourceKind: 'csv',
        mimeType: 'text/csv',
      });

      const error = doc.validateSync();

      expect(error?.errors.sourceKind).toBeDefined();
    });

    it('defaults tenantId to DEFAULT_TENANT_ID', () => {
      const doc = new DocumentModel({
        title: 'Q3 Report',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
      });

      expect(doc.tenantId).toBe(DEFAULT_TENANT_ID);
      expect(doc.validateSync()).toBeUndefined();
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let DocumentModel: Model<Document>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      DocumentModel = connection.model<Document>(Document.name, DocumentSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a document with its current-version pointer', async () => {
      const currentVersionId = new mongoose.Types.ObjectId();

      const created = await DocumentModel.create({
        title: 'Q3 Report',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        currentVersionId,
      });

      const found = await DocumentModel.findById(created._id);

      expect(found?.title).toBe('Q3 Report');
      expect(found?.sourceKind).toBe('pdf');
      expect(found?.currentVersionId?.equals(currentVersionId)).toBe(true);
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
