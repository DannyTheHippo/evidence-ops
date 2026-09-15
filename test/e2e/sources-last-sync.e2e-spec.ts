import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { Source, SourceDocument } from '../../src/database/schemas/evidence/source/source.schema';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface SourceLastSyncBody {
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  error?: string;
  nextSweepAt?: string;
}

interface SourceBody {
  lastSyncAt?: string;
  lastSyncStatus?: string;
  lastSyncError?: string;
  lastSync?: SourceLastSyncBody;
}

/**
 * New response shape (`SourceLastSyncResponseDto`), so this is its own e2e file per §
 * Testing Conventions rather than an extension of `sources.e2e-spec.ts`.
 */
describe('Sources last sync (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let tenantId: string;
  let sourceModel: Model<SourceDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = {
      email: 'sources-last-sync-e2e@example.com',
      password: 'correct-horse-battery',
    };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    sourceModel = app.get<Model<SourceDocument>>(getModelToken(Source.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /sources/:id', () => {
    it('projects lastSync, including nextSweepAt, for a source an active loop is still syncing', async () => {
      const lastSyncAt = new Date('2026-07-01T00:01:12.000Z');
      const created = await sourceModel.create({
        name: `Last Sync ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        owner: 'Jane Doe, IT',
        syncWorkflowId: 'wf-sync-1',
        lastSyncStartedAt: new Date('2026-07-01T00:00:00.000Z'),
        lastSyncAt,
        lastSyncStatus: 'ok',
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', cookie);
      const body = response.body as SourceBody;

      expect(response.status).toBe(200);
      // The flat fields stay alongside the nested object.
      expect(body.lastSyncAt).toBe(lastSyncAt.toISOString());
      expect(body.lastSyncStatus).toBe('ok');
      expect(body.lastSync).toBeDefined();
      expect(body.lastSync?.startedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(body.lastSync?.finishedAt).toBe(lastSyncAt.toISOString());
      expect(body.lastSync?.status).toBe('ok');
      expect(body.lastSync?.error).toBeUndefined();
      expect(body.lastSync?.nextSweepAt).toBeDefined();
    });

    it('projects a failed lastSync with no nextSweepAt once the source has been disabled', async () => {
      const created = await sourceModel.create({
        name: `Last Sync Failed ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        owner: 'Jane Doe, IT',
        enabled: false,
        syncWorkflowId: 'wf-sync-2',
        lastSyncStartedAt: new Date('2026-07-01T00:00:00.000Z'),
        lastSyncAt: new Date('2026-07-01T00:01:12.000Z'),
        lastSyncStatus: 'failed',
        lastSyncError: 'ENOENT: no such file or directory',
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', cookie);
      const body = response.body as SourceBody;

      expect(response.status).toBe(200);
      expect(body.lastSyncError).toBe('ENOENT: no such file or directory');
      expect(body.lastSync?.status).toBe('failed');
      expect(body.lastSync?.error).toBe('ENOENT: no such file or directory');
      expect(body.lastSync?.nextSweepAt).toBeUndefined();
    });

    it('omits lastSync entirely for a source that has never synced', async () => {
      const created = await sourceModel.create({
        name: `Never Synced ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        owner: 'Jane Doe, IT',
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/sources/${created._id.toString()}`)
        .set('Cookie', cookie);
      const body = response.body as SourceBody;

      expect(response.status).toBe(200);
      expect(body.lastSyncAt).toBeUndefined();
      expect(body.lastSync).toBeUndefined();
    });
  });

  describe('POST /sources/:id/sync', () => {
    it('records the sync run with the source as its subject', async () => {
      const created = await sourceModel.create({
        name: `Sync Subject ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        tenantId,
        owner: 'Jane Doe, IT',
      });

      const syncResponse = await request(getTestServer(app))
        .post(`/api/v1/sources/${created._id.toString()}/sync`)
        .set('Cookie', cookie);

      expect(syncResponse.status).toBe(202);

      const runResponse = await request(getTestServer(app))
        .get(`/api/v1/workflow-runs/${(syncResponse.body as { id: string }).id}`)
        .set('Cookie', cookie);
      const runBody = runResponse.body as { subjectId?: string; subjectType?: string };

      expect(runResponse.status).toBe(200);
      expect(runBody.subjectId).toBe(created._id.toString());
      expect(runBody.subjectType).toBe('Source');
    });
  });
});
