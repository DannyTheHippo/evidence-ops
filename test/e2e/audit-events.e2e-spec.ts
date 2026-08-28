import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../src/database/schemas/audit/audit-event/audit-event.schema';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface AuditEventBody {
  id: string;
  actor: string;
  action: string;
  subject: { entityType: string; entityId: string };
  timestamp: string;
  correlationId: string;
  createdAt: string;
  origin: string;
  toolName?: string;
  refusalReason?: string;
}

describe('AuditEvents (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let adminCookie: string;
  let tenantId: string;
  let auditEventModel: Model<AuditEventDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));

    // Registering provisions a brand-new tenant with the registrant as its admin. Co-tenanting the
    // member into that same tenant lets both callers see the same seeded rows, so only the role
    // (admin vs. member) is the variable under test.
    const admin = await registerTestUser(app, {
      email: 'audit-events-admin-e2e@example.com',
      password: 'correct-horse-battery',
    });
    adminCookie = admin.cookie;
    tenantId = admin.tenantId;

    const member = await registerTestUser(
      app,
      { email: 'audit-events-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    cookie = member.cookie;
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
        .set('Cookie', cookie);

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
        tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action })
        .set('Cookie', adminCookie);
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
      expect(doc.origin).toBe('api');
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere. The
      // nested `subject` keys are asserted separately since it is its own response DTO. `toolName`
      // and `refusalReason` are absent here because the seeded row never set them — an
      // undefined-valued @Expose() field drops from the JSON body rather than serializing as null.
      expect(Object.keys(doc).sort()).toEqual(
        [
          'id',
          'actor',
          'action',
          'subject',
          'timestamp',
          'correlationId',
          'createdAt',
          'origin',
        ].sort(),
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
        tenantId,
      });
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action: actionB,
        subject: { entityType: 'Approval', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-beta',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action: actionA })
        .set('Cookie', adminCookie);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs.every((doc) => doc.action === actionA)).toBe(true);
    });

    it('narrows the result set with the origin filter', async () => {
      const suffix = new Types.ObjectId().toString();
      const action = `audit-e2e.origin-${suffix}`;
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Answer', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-origin-api',
        origin: 'api',
        tenantId,
      });
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Answer', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-origin-mcp',
        origin: 'mcp',
        toolName: 'get_answer',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action, origin: 'mcp' })
        .set('Cookie', adminCookie);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs[0].origin).toBe('mcp');
      expect(body.docs[0].toolName).toBe('get_answer');
    });

    it('narrows the result set with the refusalReason filter', async () => {
      const suffix = new Types.ObjectId().toString();
      const action = `audit-e2e.refusal-${suffix}`;
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Answer', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-refusal-denied',
        origin: 'mcp',
        refusalReason: 'authz-denied',
        tenantId,
      });
      await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Answer', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-refusal-invalid',
        origin: 'mcp',
        refusalReason: 'invalid-arguments',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action, refusalReason: 'authz-denied' })
        .set('Cookie', adminCookie);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs[0].refusalReason).toBe('authz-denied');
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
        tenantId,
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
        .set('Cookie', adminCookie);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].subject.entityId).toBe(ownEntityId.toString());
    });

    it('returns 400 for a sort field outside the declared allowlist', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ sort: 'actor' })
        .set('Cookie', adminCookie);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a sortDir outside asc/desc', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ sort: 'origin', sortDir: 'ascending' })
        .set('Cookie', adminCookie);

      expect(response.status).toBe(400);
    });

    it('sorts by origin ascending when asked, instead of the createdAt-descending default', async () => {
      const action = `audit-e2e.sort-${new Types.ObjectId().toString()}`;
      const mcpRow = await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Approval', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-sort-mcp',
        origin: 'mcp',
        tenantId,
      });
      const apiRow = await auditEventModel.create({
        actor: new Types.ObjectId(),
        action,
        subject: { entityType: 'Approval', entityId: new Types.ObjectId() },
        timestamp: new Date(),
        correlationId: 'corr-sort-api',
        origin: 'api',
        tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/audit-events')
        .query({ action, sort: 'origin', sortDir: 'asc' })
        .set('Cookie', adminCookie);
      const body = response.body as { docs: AuditEventBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.map((doc) => doc.id)).toEqual([
        apiRow._id.toString(),
        mcpRow._id.toString(),
      ]);
    });
  });
});
