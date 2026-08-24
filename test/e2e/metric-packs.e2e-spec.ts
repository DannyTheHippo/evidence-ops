import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import {
  MetricPack,
  MetricPackDocument,
  type MetricDefinition,
} from '../../src/database/schemas/evidence/metric-pack/metric-pack.schema';
import { CRE_PACK_V1 } from '../../src/features/evidence/facts/packs/cre.pack';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface MetricPackBody {
  id: string;
  packId: string;
  version: number;
  status: string;
  label: string;
  metrics: MetricDefinition[];
  parentPackId?: string;
  parentVersion?: number;
  createdAt: string;
}

const METRIC_PACK_KEYS = [
  'id',
  'packId',
  'version',
  'status',
  'label',
  'metrics',
  'parentPackId',
  'parentVersion',
  'createdAt',
].sort();

/** A full, deep clone of the code default's metric set, in the request DTO's own shape — every
 *  field `MetricDefinitionRequestDto`/`MetricUnitDefinitionRequestDto` accept and no others, so it
 *  passes write-time validation unmodified, and it survives the publish-time removal and
 *  frozen-arithmetic checks unmodified because nothing about it differs from the parent it is
 *  published against. */
function cloneCreMetrics(): MetricDefinition[] {
  return CRE_PACK_V1.metrics.map((metric) => ({
    ...metric,
    aliases: [...metric.aliases],
    units: metric.units.map((unit) => ({ ...unit })),
    authorityOrder: metric.authorityOrder ? [...metric.authorityOrder] : undefined,
  }));
}

describe('Metric Packs (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let memberCookie: string;
  let metricPackModel: Model<MetricPackDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const admin = await registerTestUser(app, {
      email: 'metric-packs-e2e@example.com',
      password: 'correct-horse-battery',
    });
    cookie = admin.cookie;

    // Co-tenanting the member the same way `metric-policies.e2e-spec.ts` does — both callers see
    // the same seeded rows, so only the role (admin vs. member) is the variable under test.
    const member = await registerTestUser(
      app,
      { email: 'metric-packs-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId: admin.tenantId },
    );
    memberCookie = member.cookie;

    metricPackModel = app.get<Model<MetricPackDocument>>(getModelToken(MetricPack.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /metric-packs', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/metric-packs');

      expect(response.status).toBe(401);
    });

    it('lists an empty set for a tenant with nothing authored yet', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/metric-packs')
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ docs: [], count: 0 });
    });
  });

  describe('mutating routes require the Admin role', () => {
    it('rejects an unauthenticated create', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/metric-packs/member-guard/versions')
        .send({ label: 'x', metrics: [] });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member creating a version', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/metric-packs/member-guard/versions')
        .set('Cookie', memberCookie)
        .send({ label: 'x', metrics: [] });

      expect(response.status).toBe(403);
    });

    it('returns 403 for a Member publishing a version', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/metric-packs/member-guard/versions/1/publish')
        .set('Cookie', memberCookie)
        .send({});

      expect(response.status).toBe(403);
    });

    it('returns 403 for a Member activating a version', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/metric-packs/member-guard/versions/1/activate')
        .set('Cookie', memberCookie)
        .send();

      expect(response.status).toBe(403);
    });
  });

  describe('draft -> publish -> activate', () => {
    it('walks a version from draft to active, exposing the exact key set', async () => {
      const createResponse = await request(getTestServer(app))
        .post('/api/v1/metric-packs/cre-fork/versions')
        .set('Cookie', cookie)
        .send({ label: 'CRE Fork', metrics: cloneCreMetrics() });
      const created = createResponse.body as MetricPackBody;

      expect(createResponse.status).toBe(201);
      expect(created.packId).toBe('cre-fork');
      expect(created.version).toBe(1);
      expect(created.status).toBe('draft');
      expect(created.parentPackId).toBe('cre');
      expect(created.parentVersion).toBe(1);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(created).sort()).toEqual(METRIC_PACK_KEYS);

      const publishResponse = await request(getTestServer(app))
        .post('/api/v1/metric-packs/cre-fork/versions/1/publish')
        .set('Cookie', cookie)
        .send({});
      const published = publishResponse.body as MetricPackBody;

      expect(publishResponse.status).toBe(200);
      expect(published.status).toBe('published');

      const activateResponse = await request(getTestServer(app))
        .post('/api/v1/metric-packs/cre-fork/versions/1/activate')
        .set('Cookie', cookie)
        .send();
      const activated = activateResponse.body as MetricPackBody;

      expect(activateResponse.status).toBe(200);
      expect(activated.status).toBe('active');

      const stored = await metricPackModel.findOne({ packId: 'cre-fork', version: 1 });
      expect(stored?.status).toBe('active');
    });
  });

  describe('publish refuses an unacknowledged metric removal', () => {
    /**
     * The acceptance bar this scenario exists for: a rejected publish must leave nothing
     * persisted. Dropping `lease_term_years` from the draft without acknowledging it must refuse
     * the publish and leave the version exactly as `draft` — asserting the status code alone would
     * not catch a partial write.
     */
    it('rejects the publish and leaves the version draft, proven via a follow-up GET', async () => {
      const metricsWithoutLeaseTerm = cloneCreMetrics().filter(
        (metric) => metric.id !== 'lease_term_years',
      );

      const createResponse = await request(getTestServer(app))
        .post('/api/v1/metric-packs/cre-fork-removal/versions')
        .set('Cookie', cookie)
        .send({ label: 'Drops lease term', metrics: metricsWithoutLeaseTerm });
      expect(createResponse.status).toBe(201);

      const publishResponse = await request(getTestServer(app))
        .post('/api/v1/metric-packs/cre-fork-removal/versions/1/publish')
        .set('Cookie', cookie)
        .send({});

      expect(publishResponse.status).toBe(409);
      expect((publishResponse.body as { message: string }).message).toContain('lease_term_years');

      const listResponse = await request(getTestServer(app))
        .get('/api/v1/metric-packs')
        .set('Cookie', cookie);
      const body = listResponse.body as { docs: MetricPackBody[] };
      const row = body.docs.find((doc) => doc.packId === 'cre-fork-removal' && doc.version === 1);

      expect(row?.status).toBe('draft');
    });
  });

  describe('publish refuses a conversion-factor edit', () => {
    /**
     * `normalizeFactValue` re-multiplies every stored fact's raw `{amount, unit}` against the
     * active pack's factors on every scan, so a `toCanonicalFactor` edit on a unit the parent
     * already defined would silently reinterpret every fact stamped under an earlier version — the
     * single most important rule this feature enforces.
     */
    it('rejects the publish with a reason naming the metric and unit, leaving the version draft', async () => {
      const metricsWithChangedFactor = cloneCreMetrics().map((metric) =>
        metric.id === 'sale_price'
          ? {
              ...metric,
              units: metric.units.map((unit) =>
                unit.id === 'usd_thousands' ? { ...unit, toCanonicalFactor: 999 } : unit,
              ),
            }
          : metric,
      );

      const createResponse = await request(getTestServer(app))
        .post('/api/v1/metric-packs/cre-fork-factor/versions')
        .set('Cookie', cookie)
        .send({ label: 'Changes a factor', metrics: metricsWithChangedFactor });
      expect(createResponse.status).toBe(201);

      const publishResponse = await request(getTestServer(app))
        .post('/api/v1/metric-packs/cre-fork-factor/versions/1/publish')
        .set('Cookie', cookie)
        .send({});

      expect(publishResponse.status).toBe(409);
      const message = (publishResponse.body as { message: string }).message;
      expect(message).toContain('usd_thousands');
      expect(message).toContain('sale_price');

      const stored = await metricPackModel.findOne({ packId: 'cre-fork-factor', version: 1 });
      expect(stored?.status).toBe('draft');
    });
  });
});
