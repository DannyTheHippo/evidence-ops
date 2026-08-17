import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import {
  Conflict,
  ConflictSchema,
} from '../../../../../src/database/schemas/evidence/conflict/conflict.schema';

jest.setTimeout(60000);

const factKey = { entity: 'Acme Corp', metric: 'revenue', period: 'Q3-2025' };

// Required, not optional: the incremental conflict scan looks conflicts up by
// `{tenantId, status, groupKeyNormalized}`, so one persisted without it is invisible to every
// keyed scan and to the idempotency check that stops duplicates being opened.
const groupKeyNormalized = 'acme corp::revenue::Q3-2025';

describe('Conflict schema', () => {
  describe('validation (offline — no database connection)', () => {
    const ConflictModel = mongoose.model<Conflict>('ConflictValidationOnly', ConflictSchema);

    it('requires factKey, factIds, magnitude, groupKeyNormalized, and tenantId', () => {
      const conflict = new ConflictModel({});

      const error = conflict.validateSync();

      expect(error?.errors.factKey).toBeDefined();
      expect(error?.errors.factIds).toBeDefined();
      expect(error?.errors.magnitude).toBeDefined();
      expect(error?.errors.groupKeyNormalized).toBeDefined();
      expect(error?.errors.tenantId).toBeDefined();
    });

    it('rejects fewer than two conflicting factIds', () => {
      const conflict = new ConflictModel({
        factKey,
        groupKeyNormalized,
        factIds: [new mongoose.Types.ObjectId()],
        magnitude: 0.04,
      });

      const error = conflict.validateSync();

      expect(error?.errors.factIds).toBeDefined();
    });

    it('accepts two or more conflicting factIds and defaults status to open', () => {
      const conflict = new ConflictModel({
        factKey,
        groupKeyNormalized,
        factIds: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()],
        magnitude: 0.04,
        tenantId: 'tenant-a',
      });

      expect(conflict.validateSync()).toBeUndefined();
      expect(conflict.status).toBe('open');
      expect(conflict.tenantId).toBe('tenant-a');
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

      const created = await ConflictModel.create({
        factKey,
        groupKeyNormalized,
        factIds,
        magnitude: 0.04,
        tenantId: 'tenant-a',
      });

      const found = await ConflictModel.findById(created._id);

      expect(found?.factIds.map(String)).toEqual(factIds.map(String));
      expect(found?.tenantId).toBe('tenant-a');
    });
  });
});
