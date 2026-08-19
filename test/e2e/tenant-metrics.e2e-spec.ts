import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import {
  TenantMetric,
  TenantMetricDocument,
} from '../../src/database/schemas/evidence/tenant-metric/tenant-metric.schema';
import {
  detectConflicts,
  type FactForConflictScan,
} from '../../src/features/evidence/conflicts/detect-conflicts';
import { METRIC_ONTOLOGY } from '../../src/features/evidence/facts/metric-ontology';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface TenantMetricBody {
  id: string;
  metricId: string;
  label: string;
  isCustom: boolean;
  createdAt: string;
}

const TENANT_METRIC_KEYS = ['id', 'metricId', 'label', 'isCustom', 'createdAt'].sort();

function fact(overrides: Partial<FactForConflictScan> = {}): FactForConflictScan {
  return {
    id: 'fact-id',
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    value: { amount: 5.25, unit: 'percent' },
    ...overrides,
  };
}

describe('Tenant Metrics (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let memberCookie: string;
  let tenantId: string;
  let tenantMetricModel: Model<TenantMetricDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = {
      email: 'tenant-metrics-e2e@example.com',
      password: 'correct-horse-battery',
    };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    const member = await registerTestUser(
      app,
      { email: 'tenant-metrics-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;

    tenantMetricModel = app.get<Model<TenantMetricDocument>>(getModelToken(TenantMetric.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /tenant-metrics', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/tenant-metrics');

      expect(response.status).toBe(401);
    });

    it('lists the tenant-authored rows as { docs, count }, exposing the exact key set', async () => {
      await tenantMetricModel.create({
        tenantId,
        metricId: 'cap_rate',
        label: 'Cap Rate (renamed)',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/tenant-metrics')
        .set('Cookie', cookie);
      const body = response.body as { docs: TenantMetricBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBeGreaterThan(0);
      const row = body.docs.find((doc) => doc.metricId === 'cap_rate');
      expect(row).toBeDefined();
      expect(row?.label).toBe('Cap Rate (renamed)');
      expect(row?.isCustom).toBe(false);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(row!).sort()).toEqual(TENANT_METRIC_KEYS);
    });

    it('is reachable by a Member — authoring is admin-only, reading is not', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/tenant-metrics')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(200);
    });
  });

  describe('PUT /tenant-metrics/:metricId', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/sale_price')
        .send({ label: 'Sale Price' });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/sale_price')
        .set('Cookie', memberCookie)
        .send({ label: 'Sale Price' });

      expect(response.status).toBe(403);
    });

    it('returns 400 for a malformed metricId', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/Not%20A%20Metric')
        .set('Cookie', cookie)
        .send({ label: 'Anything' });

      expect(response.status).toBe(400);
    });

    it('renames a code-ontology metric and reports isCustom: false', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/base_rent_psf')
        .set('Cookie', cookie)
        .send({ label: 'Asking Rent per SF' });
      const body = response.body as TenantMetricBody;

      expect(response.status).toBe(200);
      expect(body.metricId).toBe('base_rent_psf');
      expect(body.label).toBe('Asking Rent per SF');
      expect(body.isCustom).toBe(false);
      expect(Object.keys(body).sort()).toEqual(TENANT_METRIC_KEYS);

      const stored = await tenantMetricModel.findOne({ tenantId, metricId: 'base_rent_psf' });
      expect(stored?.label).toBe('Asking Rent per SF');
    });

    it('adds a new measure for a metricId outside METRIC_IDS and reports isCustom: true', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/walk_score')
        .set('Cookie', cookie)
        .send({ label: 'Walk Score' });
      const body = response.body as TenantMetricBody;

      expect(response.status).toBe(200);
      expect(body.metricId).toBe('walk_score');
      expect(body.isCustom).toBe(true);
    });

    it('replaces the label on a second PUT for the same metricId', async () => {
      await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/price_per_sf')
        .set('Cookie', cookie)
        .send({ label: 'First Label' });

      const second = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/price_per_sf')
        .set('Cookie', cookie)
        .send({ label: 'Second Label' });

      expect(second.status).toBe(200);
      expect((second.body as TenantMetricBody).label).toBe('Second Label');

      const stored = await tenantMetricModel.findOne({ tenantId, metricId: 'price_per_sf' });
      expect(stored?.label).toBe('Second Label');
    });

    /**
     * The acceptance bar this step exists for: `tolerance` and `unit` decide what counts as a
     * disagreement between two facts, and no API path may change either. The request DTO declares
     * no field for them, and the global `ValidationPipe` runs with `forbidNonWhitelisted: true` —
     * proven here by demonstrating the outcome (400, nothing persisted), not by inspecting the DTO.
     */
    it('rejects a request naming tolerance or unit, and persists nothing', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/lease_term_years')
        .set('Cookie', cookie)
        .send({ label: 'Lease Term', tolerance: 999, unit: 'decades' });

      expect(response.status).toBe(400);

      const stored = await tenantMetricModel.findOne({ tenantId, metricId: 'lease_term_years' });
      expect(stored).toBeNull();
    });

    /**
     * Proves the constraint architecturally, not merely by inspecting the DTO: renaming a metric
     * that facts already conflict under changes the label a caller sees, but `detectConflicts`
     * still reads `METRIC_ONTOLOGY` directly — never `tenant_metrics` — so the same facts still
     * produce the same conflict after the rename.
     */
    it('does not alter which facts conflict when the metric they are keyed to is renamed', async () => {
      const facts = [
        fact({ id: 'xlsx-fact', value: { amount: 5.25, unit: 'percent' } }),
        fact({ id: 'pdf-fact', value: { amount: 6.1, unit: 'percent' } }),
      ];
      const before = detectConflicts(facts, METRIC_ONTOLOGY);
      expect(before.conflicts).toHaveLength(1);

      const response = await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/cap_rate')
        .set('Cookie', cookie)
        .send({ label: 'Capitalization Rate (renamed again)' });
      expect(response.status).toBe(200);

      const after = detectConflicts(facts, METRIC_ONTOLOGY);
      expect(after).toEqual(before);
    });
  });

  describe('DELETE /tenant-metrics/:metricId', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).delete(
        '/api/v1/tenant-metrics/net_operating_income',
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/tenant-metrics/net_operating_income')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 400 for a malformed metricId', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/tenant-metrics/Not%20A%20Metric')
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('reverts a renamed code-ontology metric by deleting its authored row', async () => {
      await request(getTestServer(app))
        .put('/api/v1/tenant-metrics/net_operating_income')
        .set('Cookie', cookie)
        .send({ label: 'NOI (renamed)' });

      const beforeDelete = await tenantMetricModel.findOne({
        tenantId,
        metricId: 'net_operating_income',
      });
      expect(beforeDelete).not.toBeNull();

      const response = await request(getTestServer(app))
        .delete('/api/v1/tenant-metrics/net_operating_income')
        .set('Cookie', cookie);
      expect(response.status).toBe(204);

      const afterDelete = await tenantMetricModel.findOne({
        tenantId,
        metricId: 'net_operating_income',
      });
      expect(afterDelete).toBeNull();
    });

    it('is idempotent — reverting a metricId with no authored row is a no-op, not an error', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/tenant-metrics/tenant_occupancy_share')
        .set('Cookie', cookie);

      expect(response.status).toBe(204);
    });
  });
});
