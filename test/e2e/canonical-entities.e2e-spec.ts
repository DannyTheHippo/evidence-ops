import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import {
  CanonicalEntity,
  CanonicalEntityDocument,
} from '../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import { CanonicalEntityService } from '../../src/features/evidence/facts/canonical-entity.service';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface CanonicalEntityBody {
  id: string;
  canonicalName: string;
  aliases: string[];
  createdAt: string;
}

const CANONICAL_ENTITY_KEYS = ['id', 'canonicalName', 'aliases', 'createdAt'].sort();

describe('Canonical Entities (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let memberCookie: string;
  let tenantId: string;
  let canonicalEntityModel: Model<CanonicalEntityDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = {
      email: 'canonical-entities-e2e@example.com',
      password: 'correct-horse-battery',
    };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    // Co-tenanting the member the same way `metric-policies.e2e-spec.ts` does — both callers see
    // the same seeded rows, so only the role (admin vs. member) is the variable under test.
    const member = await registerTestUser(
      app,
      { email: 'canonical-entities-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;

    canonicalEntityModel = app.get<Model<CanonicalEntityDocument>>(
      getModelToken(CanonicalEntity.name),
    );
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /canonical-entities', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/canonical-entities');

      expect(response.status).toBe(401);
    });

    it('lists the tenant-registered rows as { docs, count }, exposing the exact key set', async () => {
      await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Northgate Business Park',
        aliases: ['Northgate Bus. Park'],
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .set('Cookie', cookie);
      const body = response.body as { docs: CanonicalEntityBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBeGreaterThan(0);
      const row = body.docs.find((doc) => doc.canonicalName === 'Northgate Business Park');
      expect(row).toBeDefined();
      expect(row?.aliases).toEqual(['Northgate Bus. Park']);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose(), or catches `canonicalNameNormalized`/`aliasesNormalized` leaking through —
      // such a field is silently dropped or silently exposed with no error anywhere.
      expect(Object.keys(row!).sort()).toEqual(CANONICAL_ENTITY_KEYS);
    });

    it('is reachable by a Member — authoring is admin-only, reading is not', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/canonical-entities')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(200);
    });
  });

  describe('POST /canonical-entities', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .send({ canonicalName: 'Sablewood Retail Court' });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', memberCookie)
        .send({ canonicalName: 'Sablewood Retail Court' });

      expect(response.status).toBe(403);
    });

    it('creates a row and exposes the exact key set', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Sablewood Retail Court', aliases: ['Sablewood'] });
      const body = response.body as CanonicalEntityBody;

      expect(response.status).toBe(201);
      expect(body.canonicalName).toBe('Sablewood Retail Court');
      expect(body.aliases).toEqual(['Sablewood']);
      expect(Object.keys(body).sort()).toEqual(CANONICAL_ENTITY_KEYS);
    });

    /**
     * The acceptance bar this step exists for: a duplicate canonical name must surface as a
     * feature exception, never as an unhandled 500 from a raw `MongoServerError` E11000 —
     * `GlobalExceptionFilter` collapses any non-`HttpException` to a 500 that loses the detail.
     */
    it('returns 409, not 500, for a duplicate canonical name', async () => {
      await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Duplicate Plaza' });

      const response = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Duplicate Plaza' });

      expect(response.status).toBe(409);
    });
  });

  describe('PATCH /canonical-entities/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Patch Auth Test',
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .send({ canonicalName: 'Renamed' });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Patch Forbidden Test',
      });

      const response = await request(getTestServer(app))
        .patch(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .set('Cookie', memberCookie)
        .send({ canonicalName: 'Renamed' });

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id with no row in this tenant', async () => {
      const response = await request(getTestServer(app))
        .patch('/api/v1/canonical-entities/65f1c2e4a1b2c3d4e5f6a7b8')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Renamed' });

      expect(response.status).toBe(404);
    });

    /**
     * The assertion that catches the stale-normalized-field trap: `CanonicalEntity`'s
     * `pre('validate')` hook derives `canonicalNameNormalized`/`aliasesNormalized`, and only
     * fires on a document `.save()`, not on a `findOneAndUpdate`-style write. A PATCH that used
     * the latter would rewrite `canonicalName` while leaving `canonicalNameNormalized` stale, so
     * the row would silently stop resolving under its new name — passing the response-body
     * assertions below while failing the resolver check that actually matters.
     */
    it('renames an entity and leaves the row resolvable by its new name', async () => {
      const created = await request(getTestServer(app))
        .post('/api/v1/canonical-entities')
        .set('Cookie', cookie)
        .send({ canonicalName: 'Old Plaza Name', aliases: ['Old Plaza Alias'] });
      const { id } = created.body as CanonicalEntityBody;

      const response = await request(getTestServer(app))
        .patch(`/api/v1/canonical-entities/${id}`)
        .set('Cookie', cookie)
        .send({ canonicalName: 'New Plaza Name' });
      const body = response.body as CanonicalEntityBody;

      expect(response.status).toBe(200);
      expect(body.canonicalName).toBe('New Plaza Name');
      expect(Object.keys(body).sort()).toEqual(CANONICAL_ENTITY_KEYS);

      const canonicalEntityService = app.get(CanonicalEntityService);
      const resolvedByNewName = await canonicalEntityService.resolve('New Plaza Name', tenantId);
      expect(resolvedByNewName).toEqual({ name: 'New Plaza Name', matched: true });

      const resolvedByOldName = await canonicalEntityService.resolve('Old Plaza Name', tenantId);
      expect(resolvedByOldName).toEqual({ name: 'Old Plaza Name', matched: false });

      // The alias set survives a rename that omits `aliases` from the request body.
      const resolvedByAlias = await canonicalEntityService.resolve('Old Plaza Alias', tenantId);
      expect(resolvedByAlias).toEqual({ name: 'New Plaza Name', matched: true });
    });
  });

  describe('DELETE /canonical-entities/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Delete Auth Test',
      });

      const response = await request(getTestServer(app)).delete(
        `/api/v1/canonical-entities/${entity._id.toString()}`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Delete Forbidden Test',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id with no row in this tenant', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/canonical-entities/65f1c2e4a1b2c3d4e5f6a7b8')
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('deletes the row, which no longer resolves', async () => {
      const entity = await canonicalEntityModel.create({
        tenantId,
        canonicalName: 'Delete Target Plaza',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/canonical-entities/${entity._id.toString()}`)
        .set('Cookie', cookie);
      expect(response.status).toBe(204);

      const stored = await canonicalEntityModel.findOne({ _id: entity._id, tenantId });
      expect(stored).toBeNull();

      const canonicalEntityService = app.get(CanonicalEntityService);
      const resolved = await canonicalEntityService.resolve('Delete Target Plaza', tenantId);
      expect(resolved).toEqual({ name: 'Delete Target Plaza', matched: false });
    });
  });
});
