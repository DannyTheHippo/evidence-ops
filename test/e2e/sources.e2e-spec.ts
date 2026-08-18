import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { Types } from 'mongoose';
import { Source, SourceDocument } from '../../src/database/schemas/evidence/source/source.schema';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

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

interface SourceFileStateBody {
  path: string;
  status: string;
  lastError?: string;
  mtimeMs: number;
}

interface SourceWithFileStatesBody extends SourceBody {
  fileStates: SourceFileStateBody[];
}

interface WorkflowRunBody {
  id: string;
  workflowId: string;
  workflowType?: string;
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
  'fileStates',
].sort();

/** A file state with `lastError` set — the only state in which `lastError` is observable on the
 *  nested shape, for the same reason `FRESH_SOURCE_KEYS` exists for the source itself. */
const FAILED_FILE_STATE_KEYS = ['path', 'status', 'lastError', 'mtimeMs'].sort();

const OK_FILE_STATE_KEYS = ['path', 'status', 'mtimeMs'].sort();

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
  let tenantId: string;
  let sourceModel: Model<SourceDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'sources-e2e@example.com', password: 'correct-horse-battery' };
    ({ token, tenantId } = await registerTestUser(app, credentials));

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
        tenantId,
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
     * absent. The same reasoning applies to the nested `fileStates` entries: a file with no
     * `lastError` is what proves the field is genuinely optional there too, and a file with
     * `lastError` set is the only state in which that field is observable at all.
     */
    it('gets a fully-synced source and exposes the exact key set', async () => {
      const okFileState = {
        path: 'contracts/lease-agreement.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 245_760,
        mtimeMs: 1_753_920_000_000,
        documentId: new Types.ObjectId(),
      };
      const failedFileState = {
        path: 'contracts/broken-scan.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 8192,
        mtimeMs: 1_753_920_100_000,
        documentId: new Types.ObjectId(),
        lastError: "Could not resolve a document type for 'contracts/broken-scan.pdf'",
      };
      const created = await sourceModel.create({
        name: `Getter Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        intervalMs: 300_000,
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncError: 'connector refused an oversized file',
        fileStates: [okFileState, failedFileState],
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}`)
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as SourceWithFileStatesBody;

      expect(response.status).toBe(200);
      expect(body.id).toBe(created._id.toString());
      expect(body.intervalMs).toBe(300_000);
      expect(body.lastSyncStatus).toBe('failed');
      expect(body.lastSyncError).toBe('connector refused an oversized file');
      expect(Object.keys(body).sort()).toEqual(SOURCE_KEYS);

      expect(body.fileStates).toHaveLength(2);
      const [ok, failed] = body.fileStates;
      expect(ok.path).toBe(okFileState.path);
      expect(ok.status).toBe('ok');
      expect(ok.mtimeMs).toBe(okFileState.mtimeMs);
      expect(Object.keys(ok).sort()).toEqual(OK_FILE_STATE_KEYS);

      expect(failed.path).toBe(failedFileState.path);
      expect(failed.status).toBe('failed');
      expect(failed.lastError).toBe(failedFileState.lastError);
      expect(failed.mtimeMs).toBe(failedFileState.mtimeMs);
      expect(Object.keys(failed).sort()).toEqual(FAILED_FILE_STATE_KEYS);
    });

    // The caller's token carries a real, freshly provisioned tenant id, so this only proves
    // isolation because that id genuinely differs from 'other-tenant'.
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
        tenantId,
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
        tenantId,
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

    // The caller's token carries a real, freshly provisioned tenant id, so this only proves
    // isolation because that id genuinely differs from 'other-tenant'.
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
        tenantId,
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
        tenantId,
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
      expect(Object.keys(body).sort()).toEqual(
        ['id', 'workflowId', 'workflowType', 'status', 'createdAt'].sort(),
      );
      // The label the Runs list shows in place of the opaque workflow uuid.
      expect(body.workflowType).toBe('sync-source');
    });

    // The caller's token carries a real, freshly provisioned tenant id, so this only proves
    // isolation because that id genuinely differs from 'other-tenant'.
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
