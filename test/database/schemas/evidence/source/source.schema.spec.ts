import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  Source,
  SourceSchema,
} from '../../../../../src/database/schemas/evidence/source/source.schema';

jest.setTimeout(60000);

const SHA256_FIXTURE = 'a'.repeat(64);

const buildFileState = () => ({
  path: 'inbox/q3-report.pdf',
  sha256: SHA256_FIXTURE,
  sizeBytes: 2048,
  mtimeMs: 1_700_000_000_000,
  documentId: new mongoose.Types.ObjectId(),
});

describe('Source schema', () => {
  describe('validation (offline — no database connection)', () => {
    const SourceModel = mongoose.model<Source>('SourceValidationOnly', SourceSchema);

    it('requires name, kind, and path', () => {
      const source = new SourceModel({});

      const error = source.validateSync();

      expect(error?.errors.name).toBeDefined();
      expect(error?.errors.kind).toBeDefined();
      expect(error?.errors.path).toBeDefined();
    });

    it('rejects a kind outside the supported set', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'sharepoint',
        path: './inbox',
      });

      const error = source.validateSync();

      expect(error?.errors.kind).toBeDefined();
    });

    it('defaults enabled to true, fileStates to an empty array, and tenantId to DEFAULT_TENANT_ID', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
      });

      expect(source.validateSync()).toBeUndefined();
      expect(source.enabled).toBe(true);
      expect(source.fileStates).toEqual([]);
      expect(source.tenantId).toBe(DEFAULT_TENANT_ID);
    });

    it('requires path, sha256, sizeBytes, mtimeMs, and documentId on each fileStates entry', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        fileStates: [{}],
      });

      const error = source.validateSync();

      expect(error?.errors['fileStates.0.path']).toBeDefined();
      expect(error?.errors['fileStates.0.sha256']).toBeDefined();
      expect(error?.errors['fileStates.0.sizeBytes']).toBeDefined();
      expect(error?.errors['fileStates.0.mtimeMs']).toBeDefined();
      expect(error?.errors['fileStates.0.documentId']).toBeDefined();
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let SourceModel: Model<Source>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      SourceModel = connection.model<Source>(Source.name, SourceSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a source with its fileStates, and drops the _id Mongoose would otherwise mint per entry', async () => {
      const fileState = buildFileState();

      const created = await SourceModel.create({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        fileStates: [fileState],
      });

      const found = await SourceModel.findById(created._id);
      const plain = found?.toObject();

      expect(plain?.fileStates).toHaveLength(1);
      expect(plain?.fileStates[0]).toEqual({
        path: fileState.path,
        sha256: fileState.sha256,
        sizeBytes: fileState.sizeBytes,
        mtimeMs: fileState.mtimeMs,
        documentId: fileState.documentId,
      });
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
