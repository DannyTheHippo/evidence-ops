import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../../../src/database/constants/tenant.constant';
import {
  AuditEvent,
  AuditEventSchema,
} from '../../../../../src/database/schemas/audit/audit-event/audit-event.schema';

jest.setTimeout(60000);

const buildEventInput = () => ({
  actor: new mongoose.Types.ObjectId(),
  action: 'answer.completed',
  subject: { entityType: 'Answer', entityId: new mongoose.Types.ObjectId() },
  timestamp: new Date(),
  correlationId: 'correlation-1',
});

describe('AuditEvent schema', () => {
  describe('validation (offline — no database connection)', () => {
    const AuditEventModel = mongoose.model<AuditEvent>(
      'AuditEventValidationOnly',
      AuditEventSchema,
    );

    it('requires actor, action, subject, timestamp, and correlationId', () => {
      const event = new AuditEventModel({});

      const error = event.validateSync();

      expect(error?.errors.actor).toBeDefined();
      expect(error?.errors.action).toBeDefined();
      expect(error?.errors.subject).toBeDefined();
      expect(error?.errors.timestamp).toBeDefined();
      expect(error?.errors.correlationId).toBeDefined();
    });

    it('accepts entityType/entityId as the subject shape (not `type`/`id`)', () => {
      const event = new AuditEventModel(buildEventInput());

      expect(event.validateSync()).toBeUndefined();
      expect(event.subject.entityType).toBe('Answer');
    });

    it('defaults tenantId to DEFAULT_TENANT_ID', () => {
      const event = new AuditEventModel(buildEventInput());

      expect(event.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let AuditEventModel: Model<AuditEvent>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      AuditEventModel = connection.model<AuditEvent>(AuditEvent.name, AuditEventSchema);
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    it('persists and rehydrates an append-only audit event', async () => {
      const input = buildEventInput();

      const created = await AuditEventModel.create(input);

      const found = await AuditEventModel.findById(created._id);

      expect(found?.action).toBe('answer.completed');
      expect(found?.subject.entityType).toBe('Answer');
      expect(found?.subject.entityId.equals(input.subject.entityId)).toBe(true);
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
