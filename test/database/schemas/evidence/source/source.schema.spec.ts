import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
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

    it('requires name, kind, path, and tenantId', () => {
      const source = new SourceModel({});

      const error = source.validateSync();

      expect(error?.errors.name).toBeDefined();
      expect(error?.errors.kind).toBeDefined();
      expect(error?.errors.path).toBeDefined();
      expect(error?.errors.tenantId).toBeDefined();
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

    it('defaults enabled, fileStates, sourceClass, connectivity, reachability, and tracked, and leaves owner unset', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        tenantId: 'tenant-a',
      });

      expect(source.validateSync()).toBeUndefined();
      expect(source.enabled).toBe(true);
      expect(source.fileStates).toEqual([]);
      expect(source.tenantId).toBe('tenant-a');
      expect(source.sourceClass).toBe('unclassified');
      expect(source.connectivity).toBe('connector');
      expect(source.reachability).toBe('live');
      expect(source.tracked).toBe(true);
      expect(source.owner).toBeUndefined();
    });

    it('rejects a connectivity outside the supported set', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        tenantId: 'tenant-a',
        connectivity: 'sharepoint',
      });

      const error = source.validateSync();

      expect(error?.errors.connectivity).toBeDefined();
    });

    it('rejects a reachability outside the supported set', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        tenantId: 'tenant-a',
        reachability: 'unknown',
      });

      const error = source.validateSync();

      expect(error?.errors.reachability).toBeDefined();
    });

    it('preserves an explicit owner, connectivity, reachability, and tracked', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        tenantId: 'tenant-a',
        owner: 'Jane Doe, IT',
        connectivity: 'export-only',
        reachability: 'prohibited',
        tracked: false,
      });

      expect(source.validateSync()).toBeUndefined();
      expect(source.owner).toBe('Jane Doe, IT');
      expect(source.connectivity).toBe('export-only');
      expect(source.reachability).toBe('prohibited');
      expect(source.tracked).toBe(false);
    });

    it('preserves an explicit sourceClass', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        tenantId: 'tenant-a',
        sourceClass: 'pm-export',
      });

      expect(source.validateSync()).toBeUndefined();
      expect(source.sourceClass).toBe('pm-export');
    });

    it('rejects a sourceClass outside the six supported classes', () => {
      const source = new SourceModel({
        name: 'Local inbox',
        kind: 'local-folder',
        path: './inbox',
        tenantId: 'tenant-a',
        sourceClass: 'email',
      });

      const error = source.validateSync();

      expect(error?.errors.sourceClass).toBeDefined();
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
        tenantId: 'tenant-a',
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
      expect(found?.tenantId).toBe('tenant-a');
      expect(found?.sourceClass).toBe('unclassified');
    });

    it('persists and rehydrates an explicit sourceClass', async () => {
      const created = await SourceModel.create({
        name: 'CRM sync',
        kind: 'local-folder',
        path: './crm-exports',
        tenantId: 'tenant-a',
        sourceClass: 'crm-export',
      });

      const found = await SourceModel.findById(created._id);

      expect(found?.sourceClass).toBe('crm-export');
    });
  });
});
