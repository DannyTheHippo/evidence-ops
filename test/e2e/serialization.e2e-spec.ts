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

describe('Serialization (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const credentials = {
    email: 'serialization-e2e@example.com',
    password: 'correct-horse-battery-staple',
  };

  // Regression test for the `excludeExtraneousValues` fix: only fields declared @Expose on
  // the response DTOs may reach the client, so the raw password/hash can never leak.
  it('never exposes the password or its hash in the register response', async () => {
    const response = await request(getTestServer(app))
      .post('/api/v1/auth/register')
      .send(credentials);
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
    // Exact-key assertion: the only gate catching a MeResponseDto field missing @Expose().
    expect(Object.keys(body).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  it('never exposes the password or its hash in the login response, including the nested user', async () => {
    const response = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    const body = response.body as { accessToken: string; user: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
    expect(Object.keys(body.user).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  // Regression for the inventory fields (D8): a response DTO field without @Expose() is dropped
  // silently, with no error anywhere — this is the gate that catches it for the four new Source
  // fields plus the previously write-only-by-accident sourceClass.
  it('exposes every Source inventory field in the create response', async () => {
    const { cookie } = await registerTestUser(app, {
      email: 'serialization-sources-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const response = await request(getTestServer(app))
      .post('/api/v1/sources')
      .set('Cookie', cookie)
      .send({
        name: `Serialization Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        owner: 'Jane Doe, IT',
        connectivity: 'export-only',
        reachability: 'possible',
        tracked: false,
        sourceClass: 'crm-export',
      });
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.connectivity).toBe('export-only');
    expect(body.reachability).toBe('possible');
    expect(body.owner).toBe('Jane Doe, IT');
    expect(body.tracked).toBe(false);
    expect(body.sourceClass).toBe('crm-export');
  });

  // Regression for the write-only audit fields (M1, plus modifiedCount found in the same class of
  // gap after M1 landed): `origin`, `toolName`, `refusalReason` and `modifiedCount` are written by
  // AuditService and persisted by the schema, but were readable through no DTO — this is the gate
  // that catches any of the four losing its @Expose() again.
  it('exposes origin, toolName and refusalReason in the audit-events list response', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-audit-events-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    const action = `serialization-e2e.mcp-refusal-${Date.now()}`;
    await auditEventModel.create({
      actor: new Types.ObjectId(),
      action,
      subject: { entityType: 'Answer', entityId: new Types.ObjectId() },
      timestamp: new Date(),
      correlationId: 'corr-serialization-e2e',
      origin: 'mcp',
      toolName: 'get_answer',
      refusalReason: 'authz-denied',
      tenantId,
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/audit-events')
      .query({ action })
      .set('Cookie', cookie);
    const body = response.body as { docs: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].origin).toBe('mcp');
    expect(body.docs[0].toolName).toBe('get_answer');
    expect(body.docs[0].refusalReason).toBe('authz-denied');
  });

  it('exposes modifiedCount in the audit-events list response', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-audit-events-modified-count-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    const action = 'sources.class_drift_applied';
    await auditEventModel.create({
      actor: new Types.ObjectId(),
      action,
      subject: { entityType: 'Source', entityId: new Types.ObjectId() },
      timestamp: new Date(),
      correlationId: 'corr-serialization-modified-count-e2e',
      origin: 'api',
      modifiedCount: 400,
      tenantId,
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/audit-events')
      .query({ action, entityType: 'Source' })
      .set('Cookie', cookie);
    const body = response.body as { docs: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].modifiedCount).toBe(400);
  });
});
