import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { Source, SourceDocument } from '../../src/database/schemas/evidence/source/source.schema';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

interface SourceBody {
  id: string;
  name: string;
  kind: string;
  path: string;
  enabled: boolean;
  intervalMs?: number;
  lastSyncAt?: string;
  lastSyncStatus?: string;
  lastSyncError?: string;
  fileCount: number;
  createdAt: string;
}

interface WorkflowRunBody {
  id: string;
  workflowId: string;
  status: string;
  currentStep?: string;
  errorMessage?: string;
  createdAt: string;
}

const SOURCE_KEYS = [
  'id',
  'name',
  'kind',
  'path',
  'enabled',
  'intervalMs',
  'lastSyncAt',
  'lastSyncStatus',
  'lastSyncError',
  'fileCount',
  'createdAt',
].sort();

/**
 * What a source that has never synced actually serializes to. `intervalMs`, `lastSyncAt`,
 * `lastSyncStatus` and `lastSyncError` are optional and undefined until a sweep sets them, and
 * `JSON.stringify` drops an undefined value rather than emitting a null — so they are absent from
 * the payload, matching how `WorkflowRunResponseDto`'s optional fields behave in
 * `approvals.e2e-spec.ts`. Asserting this set exactly is what catches a field leaking in that the
 * DTO never declared.
 */
const FRESH_SOURCE_KEYS = [
  'id',
  'name',
  'kind',
  'path',
  'enabled',
  'fileCount',
  'createdAt',
].sort();

describe('Sources (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let sourceModel: Model<SourceDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'sources-e2e@example.com', password: 'correct-horse-battery' };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentials);
    const login = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    token = (login.body as { accessToken: string }).accessToken;

    sourceModel = app.get<Model<SourceDocument>>(getModelToken(Source.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('POST /sources', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .send({ name: 'Deal Room Inbox', kind: 'local-folder', path: 'deal-room' });

      expect(response.status).toBe(401);
    });

    it('creates a source and exposes the exact key set', async () => {
      const name = `Deal Room ${Date.now()}`;

      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Authorization', `Bearer ${token}`)
        .send({ name, kind: 'local-folder', path: 'deal-room' });
      const body = response.body as SourceBody;

      expect(response.status).toBe(201);
      expect(body.name).toBe(name);
      expect(body.kind).toBe('local-folder');
      expect(body.enabled).toBe(true);
      expect(body.fileCount).toBe(0);
      expect(Object.keys(body).sort()).toEqual(FRESH_SOURCE_KEYS);
    });

    it('returns 409 for a duplicate name', async () => {
      const name = `Duplicate Source ${Date.now()}`;
      await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Authorization', `Bearer ${token}`)
        .send({ name, kind: 'local-folder', path: 'deal-room' });

      const response = await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Authorization', `Bearer ${token}`)
        .send({ name, kind: 'local-folder', path: 'deal-room-2' });

      expect(response.status).toBe(409);
    });
  });

  describe('GET /sources', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/sources');

      expect(response.status).toBe(401);
    });

    it('lists sources as { docs, count }', async () => {
      await request(getTestServer(app))
        .post('/api/v1/sources')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Listed Source ${Date.now()}`, kind: 'local-folder', path: 'deal-room' });

      const response = await request(getTestServer(app))
        .get('/api/v1/sources')
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as { docs: SourceBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBeGreaterThan(0);
      expect(body.docs.length).toBeGreaterThan(0);
    });
  });

  describe('GET /sources/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const created = await sourceModel.create({
        name: `Get Auth Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
      });

      const response = await request(getTestServer(app)).get(
        `/api/v1/sources/${created._id.toString()}`,
      );

      expect(response.status).toBe(401);
    });

    /**
     * Seeds every optional field populated, which is the only state in which the full key set is
     * observable. Asserting it here is what actually gates `@Expose()` on the four sync fields — a
     * missing decorator on any of them is silently dropped from the payload with no error anywhere,
     * and a source that has never synced cannot detect it because those keys are legitimately
     * absent.
     */
    it('gets a fully-synced source and exposes the exact key set', async () => {
      const created = await sourceModel.create({
        name: `Getter Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        intervalMs: 300_000,
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncError: 'connector refused an oversized file',
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}`)
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as SourceBody;

      expect(response.status).toBe(200);
      expect(body.id).toBe(created._id.toString());
      expect(body.intervalMs).toBe(300_000);
      expect(body.lastSyncStatus).toBe('failed');
      expect(body.lastSyncError).toBe('connector refused an oversized file');
      expect(Object.keys(body).sort()).toEqual(SOURCE_KEYS);
    });

    it('returns 404 for a source belonging to a different tenant, not 403', async () => {
      const otherTenantSource = await sourceModel.create({
        name: `Other Tenant Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${otherTenantSource._id.toString()}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /sources/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const created = await sourceModel.create({
        name: `Patch Auth Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${created._id.toString()}`)
        .send({ enabled: false });

      expect(response.status).toBe(401);
    });

    it('flips the enabled flag', async () => {
      const created = await sourceModel.create({
        name: `Patch Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        enabled: true,
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${created._id.toString()}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ enabled: false });
      const body = response.body as SourceBody;

      expect(response.status).toBe(200);
      expect(body.enabled).toBe(false);

      const stored = await sourceModel.findById(created._id);
      expect(stored?.enabled).toBe(false);
    });

    it('returns 404 for a source belonging to a different tenant, not 403', async () => {
      const otherTenantSource = await sourceModel.create({
        name: `Other Tenant Patch Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/sources/${otherTenantSource._id.toString()}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ enabled: false });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /sources/:id/sync', () => {
    it('rejects an unauthenticated request', async () => {
      const created = await sourceModel.create({
        name: `Sync Auth Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
      });

      const response = await request(getTestServer(app)).post(
        `/api/v1/sources/${created._id.toString()}/sync`,
      );

      expect(response.status).toBe(401);
    });

    it('starts a sync and returns a WorkflowRun-shaped body', async () => {
      const created = await sourceModel.create({
        name: `Sync Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/sources/${created._id.toString()}/sync`)
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as WorkflowRunBody;

      expect(response.status).toBe(202);
      expect(body.id).toBeDefined();
      expect(body.workflowId).toBeDefined();
      expect(body.status).toBeDefined();
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body).sort()).toEqual(['id', 'workflowId', 'status', 'createdAt'].sort());
    });

    it('returns 404 for a source belonging to a different tenant, not 403', async () => {
      const otherTenantSource = await sourceModel.create({
        name: `Other Tenant Sync Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/sources/${otherTenantSource._id.toString()}/sync`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });
  });
});
