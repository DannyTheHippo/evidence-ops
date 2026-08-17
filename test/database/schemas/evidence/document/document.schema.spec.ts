import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
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

    it('requires title, sourceKind, mimeType, and tenantId', () => {
      const doc = new DocumentModel({});

      const error = doc.validateSync();

      expect(error?.errors.title).toBeDefined();
      expect(error?.errors.sourceKind).toBeDefined();
      expect(error?.errors.mimeType).toBeDefined();
      expect(error?.errors.tenantId).toBeDefined();
    });

    it('rejects a sourceKind outside the eight supported kinds', () => {
      // 'xls' rather than an arbitrary string: the legacy binary format this project deliberately
      // does not support (see `resolveUploadKind`'s `AMBIGUOUS_UPLOAD_MIME_TYPES` comment), so this
      // also documents that widening `DOCUMENT_SOURCE_KINDS` to eight kinds did not accidentally
      // include it.
      const doc = new DocumentModel({
        title: 'Q3 Report',
        sourceKind: 'xls',
        mimeType: 'application/vnd.ms-excel',
      });

      const error = doc.validateSync();

      expect(error?.errors.sourceKind).toBeDefined();
    });

    it('accepts an explicit tenantId', () => {
      const doc = new DocumentModel({
        title: 'Q3 Report',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        tenantId: 'tenant-a',
      });

      expect(doc.tenantId).toBe('tenant-a');
      expect(doc.validateSync()).toBeUndefined();
    });

    it('defaults sourceClass to unclassified when omitted', () => {
      const doc = new DocumentModel({
        title: 'Q3 Report',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        tenantId: 'tenant-a',
      });

      expect(doc.sourceClass).toBe('unclassified');
      expect(doc.validateSync()).toBeUndefined();
    });

    it('preserves an explicit sourceClass', () => {
      const doc = new DocumentModel({
        title: 'Q3 Report',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        tenantId: 'tenant-a',
        sourceClass: 'crm-export',
      });

      expect(doc.sourceClass).toBe('crm-export');
      expect(doc.validateSync()).toBeUndefined();
    });

    it('rejects a sourceClass outside the six supported classes', () => {
      const doc = new DocumentModel({
        title: 'Q3 Report',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        tenantId: 'tenant-a',
        sourceClass: 'email',
      });

      const error = doc.validateSync();

      expect(error?.errors.sourceClass).toBeDefined();
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
        tenantId: 'tenant-a',
        currentVersionId,
      });

      const found = await DocumentModel.findById(created._id);

      expect(found?.title).toBe('Q3 Report');
      expect(found?.sourceKind).toBe('pdf');
      expect(found?.currentVersionId?.equals(currentVersionId)).toBe(true);
      expect(found?.tenantId).toBe('tenant-a');
      expect(found?.sourceClass).toBe('unclassified');
    });

    it('persists and rehydrates an explicit sourceClass', async () => {
      const created = await DocumentModel.create({
        title: 'CRM Export',
        sourceKind: 'csv',
        mimeType: 'text/csv',
        tenantId: 'tenant-a',
        sourceClass: 'crm-export',
      });

      const found = await DocumentModel.findById(created._id);

      expect(found?.sourceClass).toBe('crm-export');
    });
  });
});
