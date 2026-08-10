import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  Conflict,
  ConflictSchema,
} from '../../../../../src/database/schemas/evidence/conflict/conflict.schema';

jest.setTimeout(60000);

const factKey = { entity: 'Acme Corp', metric: 'revenue', period: 'Q3-2025' };

describe('Conflict schema', () => {
  describe('validation (offline — no database connection)', () => {
    const ConflictModel = mongoose.model<Conflict>('ConflictValidationOnly', ConflictSchema);

    it('requires factKey, factIds, and magnitude', () => {
      const conflict = new ConflictModel({});

      const error = conflict.validateSync();

      expect(error?.errors.factKey).toBeDefined();
      expect(error?.errors.factIds).toBeDefined();
      expect(error?.errors.magnitude).toBeDefined();
    });

    it('rejects fewer than two conflicting factIds', () => {
      const conflict = new ConflictModel({
        factKey,
        factIds: [new mongoose.Types.ObjectId()],
        magnitude: 0.04,
      });

      const error = conflict.validateSync();

      expect(error?.errors.factIds).toBeDefined();
    });

    it('accepts two or more conflicting factIds and defaults status to open', () => {
      const conflict = new ConflictModel({
        factKey,
        factIds: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()],
        magnitude: 0.04,
      });

      expect(conflict.validateSync()).toBeUndefined();
      expect(conflict.status).toBe('open');
      expect(conflict.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let ConflictModel: Model<Conflict>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      ConflictModel = connection.model<Conflict>(Conflict.name, ConflictSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates a conflict between two facts', async () => {
      const factIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];

      const created = await ConflictModel.create({ factKey, factIds, magnitude: 0.04 });

      const found = await ConflictModel.findById(created._id);

      expect(found?.factIds.map(String)).toEqual(factIds.map(String));
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
