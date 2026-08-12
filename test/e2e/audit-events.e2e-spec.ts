import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../src/database/schemas/audit/audit-event/audit-event.schema';
import { User, UserDocument } from '../../src/database/schemas/administration/user/user.schema';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

interface AuditEventBody {
  id: string;
  actor: string;
  action: string;
  subject: { entityType: string; entityId: string };
  timestamp: string;
  correlationId: string;
  createdAt: string;
}

describe('AuditEvents (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let adminToken: string;
  let auditEventModel: Model<AuditEventDocument>;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = {
      email: 'audit-events-e2e@example.com',
      password: 'correct-horse-battery',
    };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentials);
    const login = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    token = (login.body as { accessToken: string }).accessToken;

    auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));

    // GET /audit-events is admin-gated; a freshly-registered user defaults to `member`. Flip the
    // row directly, then re-login — the role travels in the JWT, so flipping the row without
    // re-issuing the token would leave the existing `token` unchanged (mirrors approvals.e2e-spec).
    const adminCredentials = {
      email: 'audit-events-admin-e2e@example.com',
      password: 'correct-horse-battery',
    };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(adminCredentials);
    await userModel.updateOne({ email: adminCredentials.email }, { role: UserRole.Admin });
    const adminLogin = await request(getTestServer(app))
      .post('/api/v1/auth/login')
      .send(adminCredentials);
    adminToken = (adminLogin.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /audit-events', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/audit-events');

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      // objectContaining, not toEqual: GlobalExceptionFilter also attaches `stack` below
      // prod-like environments, unrelated to what this guard asserts.
      expect(response.body).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message: 'Insufficient role for this action',
          error: 'Forbidden',
        }),
      );
    });

    it('lists a row for an admin, exposing the exact key set including the nested subject', async () => {
      const action = `audit-e2e.exact-key-set-${new Types.ObjectId().toString()}`;
      const actor = new Types.ObjectId();
      const entityId = new Types.ObjectId();
      await auditEventModel.create({
        actor,
        action,
        subject: { entityType: 'EvidenceDocument', entityId },
        timestamp: new Date(),
        correlationId: 'corr-exact-key-set',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action })
        .set('Authorization', `Bearer ${adminToken}`);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs).toHaveLength(1);
      const doc = body.docs[0];
      expect(doc.actor).toBe(actor.toString());
      expect(doc.subject).toEqual({
        entityType: 'EvidenceDocument',
        entityId: entityId.toString(),
      });
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere. The
      // nested `subject` keys are asserted separately since it is its own response DTO.
      expect(Object.keys(doc).sort()).toEqual(
        ['id', 'actor', 'action', 'subject', 'timestamp', 'correlationId', 'createdAt'].sort(),
      );
      expect(Object.keys(doc.subject).sort()).toEqual(['entityType', 'entityId'].sort());

      // Reading the audit log is itself audited — the list handler above must have recorded its
      // own row.
      const listedEvents = await auditEventModel.find({ action: 'audit-events.listed' });
      expect(listedEvents.length).toBeGreaterThan(0);
    });

    it('narrows the result set with the action filter', async () => {
      const suffix = new Types.ObjectId().toString();
      const actionA = `audit-e2e.alpha-${suffix}`;
      const actionB = `audit-e2e.beta-${suffix}`;
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action: actionA,
        subject: { entityType: 'Approval', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-alpha',
      });
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action: actionB,
        subject: { entityType: 'Approval', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-beta',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action: actionA })
        .set('Authorization', `Bearer ${adminToken}`);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs.every((doc) => doc.action === actionA)).toBe(true);
    });

    it('excludes a row belonging to a different tenant', async () => {
      const action = `audit-e2e.cross-tenant-${new Types.ObjectId().toString()}`;
      const ownEntityId = new Types.ObjectId();
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Approval', entityId: ownEntityId },
        timestamp: new Date(),
        correlationId: 'corr-own-tenant',
      });
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Approval', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-other-tenant',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action })
        .set('Authorization', `Bearer ${adminToken}`);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].subject.entityId).toBe(ownEntityId.toString());
    });
  });
});
