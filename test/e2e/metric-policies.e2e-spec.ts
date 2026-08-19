import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import {
  MetricPolicy,
  MetricPolicyDocument,
} from '../../src/database/schemas/evidence/metric-policy/metric-policy.schema';
import { MetricPoliciesService } from '../../src/features/evidence/facts/metric-policies.service';
import { resolveConflictPolicy } from '../../src/features/evidence/conflicts/resolve-conflict-policy';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface MetricPolicyBody {
  id: string;
  metric: string;
  authorityOrder?: string[];
  stalenessWindowMs?: number;
  createdAt: string;
}

const METRIC_POLICY_KEYS = [
  'id',
  'metric',
  'authorityOrder',
  'stalenessWindowMs',
  'createdAt',
].sort();

describe('Metric Policies (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let memberCookie: string;
  let tenantId: string;
  let metricPolicyModel: Model<MetricPolicyDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = {
      email: 'metric-policies-e2e@example.com',
      password: 'correct-horse-battery',
    };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    // Co-tenanting the member the same way `sources.e2e-spec.ts` does — both callers see the same
    // seeded rows, so only the role (admin vs. member) is the variable under test.
    const member = await registerTestUser(
      app,
      { email: 'metric-policies-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;

    metricPolicyModel = app.get<Model<MetricPolicyDocument>>(getModelToken(MetricPolicy.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /metric-policies', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/metric-policies');

      expect(response.status).toBe(401);
    });

    it('lists the tenant-authored rows as { docs, count }, exposing the exact key set', async () => {
      await metricPolicyModel.create({
        tenantId,
        metric: 'sale_price',
        authorityOrder: ['memo'],
        stalenessWindowMs: 5_000,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/metric-policies')
        .set('Cookie', cookie);
      const body = response.body as { docs: MetricPolicyBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBeGreaterThan(0);
      const row = body.docs.find((doc) => doc.metric === 'sale_price');
      expect(row).toBeDefined();
      expect(row?.authorityOrder).toEqual(['memo']);
      expect(row?.stalenessWindowMs).toBe(5_000);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(row!).sort()).toEqual(METRIC_POLICY_KEYS);
    });

    it('is reachable by a Member — authoring is admin-only, reading is not', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/metric-policies')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(200);
    });
  });

  describe('PUT /metric-policies/:metric', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/metric-policies/cap_rate')
        .send({ authorityOrder: ['pm-export'] });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/metric-policies/cap_rate')
        .set('Cookie', memberCookie)
        .send({ authorityOrder: ['pm-export'] });

      expect(response.status).toBe(403);
    });

    it('returns 400 for a metric outside METRIC_IDS', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/metric-policies/not_a_metric')
        .set('Cookie', cookie)
        .send({ authorityOrder: ['pm-export'] });

      expect(response.status).toBe(400);
    });

    it('upserts a policy row and persists a whole-row replace on a second PUT', async () => {
      const first = await request(getTestServer(app))
        .put('/api/v1/metric-policies/base_rent_psf')
        .set('Cookie', cookie)
        .send({ authorityOrder: ['pm-export', 'spreadsheet'], stalenessWindowMs: 10_000 });
      const firstBody = first.body as MetricPolicyBody;

      expect(first.status).toBe(200);
      expect(firstBody.authorityOrder).toEqual(['pm-export', 'spreadsheet']);
      expect(firstBody.stalenessWindowMs).toBe(10_000);
      // The upsert response goes through the same DTO as the listing, so it needs the same key-set
      // gate: a Mongoose document handed to `toResponseDto` serialises without `id`, because
      // `excludeExtraneousValues` reads own properties and `id` is a virtual getter.
      expect(Object.keys(firstBody).sort()).toEqual(METRIC_POLICY_KEYS);

      // A second PUT that omits stalenessWindowMs replaces the whole row — the field must not
      // survive from the first PUT.
      const second = await request(getTestServer(app))
        .put('/api/v1/metric-policies/base_rent_psf')
        .set('Cookie', cookie)
        .send({ authorityOrder: ['crm-export'] });
      const secondBody = second.body as MetricPolicyBody;

      expect(second.status).toBe(200);
      expect(secondBody.authorityOrder).toEqual(['crm-export']);
      expect(secondBody.stalenessWindowMs).toBeUndefined();

      const stored = await metricPolicyModel.findOne({ tenantId, metric: 'base_rent_psf' });
      expect(stored?.authorityOrder).toEqual(['crm-export']);
      expect(stored?.stalenessWindowMs).toBeUndefined();
    });

    /**
     * The acceptance bar this step exists for: a rejected write must leave nothing persisted. A
     * 400 that still wrote a partial row is the failure mode worth testing for — asserting the
     * status code alone would not catch it.
     */
    it('rejects a duplicate rank in authorityOrder and persists nothing', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/metric-policies/lease_term_years')
        .set('Cookie', cookie)
        .send({ authorityOrder: ['pm-export', 'pm-export'] });

      expect(response.status).toBe(400);

      const getResponse = await request(getTestServer(app))
        .get('/api/v1/metric-policies')
        .set('Cookie', cookie);
      const body = getResponse.body as { docs: MetricPolicyBody[] };
      expect(body.docs.some((doc) => doc.metric === 'lease_term_years')).toBe(false);
    });

    it("rejects 'unclassified' in authorityOrder and persists nothing", async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/metric-policies/tenant_occupancy_share')
        .set('Cookie', cookie)
        .send({ authorityOrder: ['pm-export', 'unclassified'] });

      expect(response.status).toBe(400);

      const getResponse = await request(getTestServer(app))
        .get('/api/v1/metric-policies')
        .set('Cookie', cookie);
      const body = getResponse.body as { docs: MetricPolicyBody[] };
      expect(body.docs.some((doc) => doc.metric === 'tenant_occupancy_share')).toBe(false);
    });

    it('rejects a stalenessWindowMs below 1 and persists nothing', async () => {
      const response = await request(getTestServer(app))
        .put('/api/v1/metric-policies/price_per_sf')
        .set('Cookie', cookie)
        .send({ stalenessWindowMs: 0 });

      expect(response.status).toBe(400);

      const getResponse = await request(getTestServer(app))
        .get('/api/v1/metric-policies')
        .set('Cookie', cookie);
      const body = getResponse.body as { docs: MetricPolicyBody[] };
      expect(body.docs.some((doc) => doc.metric === 'price_per_sf')).toBe(false);
    });
  });

  describe('DELETE /metric-policies/:metric', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).delete('/api/v1/metric-policies/cap_rate');

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/metric-policies/cap_rate')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(403);
    });

    it('returns 400 for a metric outside METRIC_IDS', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/metric-policies/not_a_metric')
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    /**
     * Reverting is asserted through `MetricPoliciesService.resolveForTenant` — the actual read
     * path a conflict resolves through — not merely by the row's absence, so this proves the
     * revert changes what the resolver produces, not just what the collection contains.
     */
    it('reverts a metric to the code ontology default, verified via the resolver', async () => {
      await request(getTestServer(app))
        .put('/api/v1/metric-policies/cap_rate')
        .set('Cookie', cookie)
        .send({ authorityOrder: ['memo'] });

      const beforeDelete = await metricPolicyModel.findOne({ tenantId, metric: 'cap_rate' });
      expect(beforeDelete).not.toBeNull();

      const response = await request(getTestServer(app))
        .delete('/api/v1/metric-policies/cap_rate')
        .set('Cookie', cookie);
      expect(response.status).toBe(204);

      const afterDelete = await metricPolicyModel.findOne({ tenantId, metric: 'cap_rate' });
      expect(afterDelete).toBeNull();

      const metricPoliciesService = app.get(MetricPoliciesService);
      const resolved = await metricPoliciesService.resolveForTenant(tenantId);
      const capRatePolicy = resolved.get('cap_rate')!;

      // Reverted, so a two-candidate tie the authored row above would have resolved by authority
      // now falls through to whatever the ontology's own cap_rate configuration produces.
      const proposal = resolveConflictPolicy(
        [
          { id: 'fact-memo', sourceClass: 'memo', observedAt: new Date('2026-01-01') },
          { id: 'fact-report', sourceClass: 'report', observedAt: new Date('2026-01-01') },
        ],
        capRatePolicy,
      );
      expect(proposal.ruleFired).toBe('none');
      expect(proposal.explanation).toBe('No authorityOrder is configured for this metric.');
    });

    it('is idempotent — reverting a metric with no authored row is a no-op, not an error', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/metric-policies/lease_term_years')
        .set('Cookie', cookie);

      expect(response.status).toBe(204);
    });
  });
});
