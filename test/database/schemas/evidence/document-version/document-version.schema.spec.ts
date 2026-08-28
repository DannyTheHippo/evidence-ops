import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../../../src/database/schemas/evidence/document-version/document-version.schema';

jest.setTimeout(60000);

const SHA256_FIXTURE = 'a'.repeat(64);

describe('DocumentVersion schema', () => {
  describe('validation (offline — no database connection)', () => {
    const DocumentVersionModel = mongoose.model<DocumentVersion>(
      'DocumentVersionValidationOnly',
      DocumentVersionSchema,
    );

    it('requires documentId, versionNumber, sha256, sizeBytes, storageKey, and tenantId', () => {
      const version = new DocumentVersionModel({});

      const error = version.validateSync();

      expect(error?.errors.documentId).toBeDefined();
      expect(error?.errors.versionNumber).toBeDefined();
      expect(error?.errors.sha256).toBeDefined();
      expect(error?.errors.sizeBytes).toBeDefined();
      expect(error?.errors.storageKey).toBeDefined();
      expect(error?.errors.tenantId).toBeDefined();
    });

    it('rejects a sha256 shorter than 64 characters', () => {
      const version = new DocumentVersionModel({
        documentId: new mongoose.Types.ObjectId(),
        versionNumber: 1,
        sha256: 'not-a-real-hash',
        sizeBytes: 1024,
        storageKey: 's3://bucket/key',
      });

      const error = version.validateSync();

      expect(error?.errors.sha256).toBeDefined();
    });

    it('accepts an explicit tenantId', () => {
      const version = new DocumentVersionModel({
        documentId: new mongoose.Types.ObjectId(),
        versionNumber: 1,
        sha256: SHA256_FIXTURE,
        sizeBytes: 1024,
        storageKey: 's3://bucket/key',
        tenantId: 'tenant-a',
      });

      expect(version.tenantId).toBe('tenant-a');
      expect(version.validateSync()).toBeUndefined();
    });

    it('defaults ingestionStatus to pending', () => {
      const version = new DocumentVersionModel({
        documentId: new mongoose.Types.ObjectId(),
        versionNumber: 1,
        sha256: SHA256_FIXTURE,
        sizeBytes: 1024,
        storageKey: 's3://bucket/key',
        tenantId: 'tenant-a',
      });

      expect(version.ingestionStatus).toBe('pending');
      expect(version.validateSync()).toBeUndefined();
    });

    it('defaults reducedFidelityReasons to an empty array', () => {
      const version = new DocumentVersionModel({
        documentId: new mongoose.Types.ObjectId(),
        versionNumber: 1,
        sha256: SHA256_FIXTURE,
        sizeBytes: 1024,
        storageKey: 's3://bucket/key',
        tenantId: 'tenant-a',
      });

      expect(version.reducedFidelityReasons).toEqual([]);
      expect(version.validateSync()).toBeUndefined();
    });

    it('rejects an ingestionStatus outside the enum', () => {
      const version = new DocumentVersionModel({
        documentId: new mongoose.Types.ObjectId(),
        versionNumber: 1,
        sha256: SHA256_FIXTURE,
        sizeBytes: 1024,
        storageKey: 's3://bucket/key',
        ingestionStatus: 'not-a-real-status',
      });

      const error = version.validateSync();

      expect(error?.errors.ingestionStatus).toBeDefined();
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let DocumentVersionModel: Model<DocumentVersion>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      DocumentVersionModel = connection.model<DocumentVersion>(
        DocumentVersion.name,
        DocumentVersionSchema,
      );
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a version pinned to its content hash', async () => {
      const documentId = new mongoose.Types.ObjectId();

      const created = await DocumentVersionModel.create({
        documentId,
        versionNumber: 1,
        sha256: SHA256_FIXTURE,
        sizeBytes: 2048,
        storageKey: 's3://bucket/q3-report-v1.pdf',
        tenantId: 'tenant-a',
      });

      const found = await DocumentVersionModel.findById(created._id);

      expect(found?.documentId.equals(documentId)).toBe(true);
      expect(found?.sha256).toBe(SHA256_FIXTURE);
      expect(found?.tenantId).toBe('tenant-a');
    });
  });
});
