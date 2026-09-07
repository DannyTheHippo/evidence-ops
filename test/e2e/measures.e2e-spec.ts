import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import {
  ExtractedFact,
  type ExtractedFactDocument,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  Measure,
  MeasureDocument,
} from '../../src/database/schemas/evidence/measure/measure.schema';
import { METRIC_IDS } from '../../src/features/evidence/facts/metric-ontology';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface MeasureUnitBody {
  id: string;
  toCanonicalFactor: number;
}

interface MeasureBody {
  id: string;
  slug: string;
  label: string;
  aliases: string[];
  valueType: string;
  canonicalUnit: string;
  units: MeasureUnitBody[];
  toleranceKind: string;
  tolerance: number;
  authorityOrder?: string[];
  stalenessWindowMs?: number;
  status: string;
  origin: string;
  proposedFrom: unknown[];
  version: number;
  confirmedBy?: string;
  confirmedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectedReason?: string;
  lastRescan?: { at: string; status: string; durationMs: number };
  createdAt: string;
}

// Every field a measure carries with neither authorityOrder nor stalenessWindowMs configured —
// the seeded `sale_price` row's own shape.
const MEASURE_BASE_KEYS = [
  'id',
  'slug',
  'label',
  'aliases',
  'valueType',
  'canonicalUnit',
  'units',
  'toleranceKind',
  'tolerance',
  'status',
  'origin',
  'proposedFrom',
  'version',
  'createdAt',
];

const MEASURE_CONFIRMED_KEYS = [
  ...MEASURE_BASE_KEYS,
  'authorityOrder',
  'stalenessWindowMs',
  'confirmedBy',
  'confirmedAt',
  'lastRescan',
].sort();

const MEASURE_REJECTED_KEYS = [
  ...MEASURE_BASE_KEYS,
  'rejectedBy',
  'rejectedAt',
  'rejectedReason',
].sort();

describe('Measures (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let adminUserId: string;
  let memberCookie: string;
  let tenantId: string;
  let measureModel: Model<MeasureDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let proposedCounter = 0;

  const createProposedMeasure = (overrides: Partial<Record<string, unknown>> = {}) => {
    proposedCounter += 1;
    return measureModel.create({
      tenantId,
      slug: `e2e_measure_${proposedCounter}`,
      label: `E2E Measure ${proposedCounter}`,
      aliases: [`E2E Measure ${proposedCounter}`],
      valueType: 'percentage',
      canonicalUnit: 'ratio',
      units: [
        { id: 'ratio', toCanonicalFactor: 1 },
        { id: 'percent', toCanonicalFactor: 0.01 },
      ],
      toleranceKind: 'absolute',
      tolerance: 0.01,
      status: 'proposed',
      origin: 'header',
      version: 1,
      proposedFrom: [
        {
          documentVersionId: new Types.ObjectId(),
          locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Sheet1', cell: 'A1' },
          headerText: `E2E Measure ${proposedCounter}`,
        },
      ],
      ...overrides,
    });
  };

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'measures-e2e@example.com', password: 'correct-horse-battery' };
    const admin = await registerTestUser(app, credentials);
    cookie = admin.cookie;
    adminUserId = admin.userId;
    tenantId = admin.tenantId;

    const member = await registerTestUser(
      app,
      { email: 'measures-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;

    measureModel = app.get<Model<MeasureDocument>>(getModelToken(Measure.name));
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /measures', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/measures');

      expect(response.status).toBe(401);
    });

    it('lists the eight seeded rows, exposing the exact key set on a bare one', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/measures')
        .query({ limit: 50 })
        .set('Cookie', cookie);
      const body = response.body as { docs: MeasureBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.map((doc) => doc.slug).sort()).toEqual([...METRIC_IDS].sort());

      // sale_price is deliberately unconfigured in METRIC_ONTOLOGY: no authorityOrder, no
      // stalenessWindowMs — the one seeded row whose exact key set is MEASURE_BASE_KEYS alone.
      const salePrice = body.docs.find((doc) => doc.slug === 'sale_price');
      expect(salePrice).toBeDefined();
      expect(Object.keys(salePrice!).sort()).toEqual([...MEASURE_BASE_KEYS].sort());
    });

    it('is reachable by a Member — authoring is admin-only, reading is not', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/measures')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(200);
    });

    it('filters by status', async () => {
      await createProposedMeasure();

      const response = await request(getTestServer(app))
        .get('/api/v1/measures')
        .query({ status: 'proposed' })
        .set('Cookie', cookie);
      const body = response.body as { docs: MeasureBody[] };

      expect(response.status).toBe(200);
      expect(body.docs.length).toBeGreaterThan(0);
      expect(body.docs.every((doc) => doc.status === 'proposed')).toBe(true);
    });
  });

  describe('POST /measures/:id/confirm', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/measures/65f1c2e4a1b2c3d4e5f6a7b8/confirm')
        .send({});

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const proposed = await createProposedMeasure();

      const response = await request(getTestServer(app))
        .post(`/api/v1/measures/${proposed._id.toString()}/confirm`)
        .set('Cookie', memberCookie)
        .send({});

      expect(response.status).toBe(403);
    });

    it('returns 404 for an id with no row in this tenant', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/measures/65f1c2e4a1b2c3d4e5f6a7b8/confirm')
        .set('Cookie', cookie)
        .send({});

      expect(response.status).toBe(404);
    });

    it('returns 400 for an unknown body field', async () => {
      const proposed = await createProposedMeasure();

      const response = await request(getTestServer(app))
        .post(`/api/v1/measures/${proposed._id.toString()}/confirm`)
        .set('Cookie', cookie)
        .send({ bogus: true });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the merged units carry no factor-1 unit', async () => {
      const proposed = await createProposedMeasure();

      const response = await request(getTestServer(app))
        .post(`/api/v1/measures/${proposed._id.toString()}/confirm`)
        .set('Cookie', cookie)
        .send({ units: [{ id: 'percent', toCanonicalFactor: 0.01 }] });

      expect(response.status).toBe(400);
    });

    /**
     * The acceptance bar this step exists for: confirming merges edits, bumps version, stamps
     * confirmedBy, runs the synchronous rescan, and flips every fact already stamped under this
     * measure from 'proposed' to 'confirmed' — read back directly against the model, since no
     * ledger/facts endpoint exists yet in this phase.
     */
    it('confirms a proposed measure, rescans, and exposes the exact key set', async () => {
      const proposed = await createProposedMeasure({
        authorityOrder: ['pm-export'],
        stalenessWindowMs: 7_776_000_000,
        proposedFrom: [
          {
            documentVersionId: new Types.ObjectId(),
            locator: {
              kind: 'xlsx-cell',
              extractorVersion: 'v1',
              sheetName: 'Rent Roll',
              cell: 'C4',
            },
            headerText: 'Occupancy %',
          },
          {
            documentVersionId: new Types.ObjectId(),
            locator: {
              kind: 'xlsx-cell',
              extractorVersion: 'v1',
              sheetName: 'Rent Roll 2',
              cell: 'D8',
            },
            headerText: 'Occupancy % (2)',
          },
        ],
      });

      const fact = await extractedFactModel.create({
        factKey: { entity: 'Occupancy Fact Property', metric: proposed.slug, period: '2026-07' },
        value: { amount: 92, unit: 'percent' },
        groupKeyNormalized: `occupancy fact property::${proposed.slug}::2026-07`,
        rawText: '92%',
        confidence: 0.95,
        extractionMethod: 'regex',
        packId: 'cre',
        packVersion: 1,
        measureId: proposed._id,
        measureVersion: proposed.version,
        measureStatus: 'proposed',
        chunkId: 'chunk-occupancy',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Rent Roll', cell: 'C4' },
        tenantId,
        entityMatched: false,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/measures/${proposed._id.toString()}/confirm`)
        .set('Cookie', cookie)
        .send({ tolerance: 0.02, aliases: ['Occupancy %'] });
      const body = response.body as MeasureBody;

      expect(response.status).toBe(200);
      expect(body.status).toBe('confirmed');
      expect(body.version).toBe(2);
      expect(body.confirmedBy).toBe(adminUserId);
      expect(body.aliases).toEqual(['Occupancy %']);
      expect(body.tolerance).toBe(0.02);
      expect(body.lastRescan?.status).toBe('completed');
      expect(Object.keys(body).sort()).toEqual(MEASURE_CONFIRMED_KEYS);

      const storedFact = await extractedFactModel.findOne({ _id: fact._id });
      expect(storedFact?.measureStatus).toBe('confirmed');

      // Confirming a second time is refused: the row is no longer 'proposed'.
      const secondConfirm = await request(getTestServer(app))
        .post(`/api/v1/measures/${proposed._id.toString()}/confirm`)
        .set('Cookie', cookie)
        .send({});
      expect(secondConfirm.status).toBe(409);
    });
  });

  describe('POST /measures/:id/reject', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/measures/65f1c2e4a1b2c3d4e5f6a7b8/reject')
        .send({});

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const proposed = await createProposedMeasure();

      const response = await request(getTestServer(app))
        .post(`/api/v1/measures/${proposed._id.toString()}/reject`)
        .set('Cookie', memberCookie)
        .send({});

      expect(response.status).toBe(403);
    });

    it('rejects a proposed measure with a reason, exposing the exact key set', async () => {
      const proposed = await createProposedMeasure();

      const response = await request(getTestServer(app))
        .post(`/api/v1/measures/${proposed._id.toString()}/reject`)
        .set('Cookie', cookie)
        .send({ reason: 'duplicate' });
      const body = response.body as MeasureBody;

      expect(response.status).toBe(200);
      expect(body.status).toBe('rejected');
      expect(body.rejectedReason).toBe('duplicate');
      expect(body.rejectedBy).toBe(adminUserId);
      expect(Object.keys(body).sort()).toEqual(MEASURE_REJECTED_KEYS);
    });
  });

  describe('PATCH /measures/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .patch('/api/v1/measures/65f1c2e4a1b2c3d4e5f6a7b8')
        .send({ tolerance: 0.5 });

      expect(response.status).toBe(401);
    });

    it('returns 403 for a Member', async () => {
      const proposed = await createProposedMeasure();
      const confirmed = await measureModel.findOneAndUpdate(
        { _id: proposed._id },
        { $set: { status: 'confirmed', version: 2 } },
        { new: true },
      );

      const response = await request(getTestServer(app))
        .patch(`/api/v1/measures/${confirmed!._id.toString()}`)
        .set('Cookie', memberCookie)
        .send({ tolerance: 0.5 });

      expect(response.status).toBe(403);
    });

    it('returns 409 for a proposed row — only a confirmed measure can be edited', async () => {
      const proposed = await createProposedMeasure();

      const response = await request(getTestServer(app))
        .patch(`/api/v1/measures/${proposed._id.toString()}`)
        .set('Cookie', cookie)
        .send({ tolerance: 0.5 });

      expect(response.status).toBe(409);
    });

    it('returns 400 for an unknown body field', async () => {
      const proposed = await createProposedMeasure();
      const confirmed = await measureModel.findOneAndUpdate(
        { _id: proposed._id },
        { $set: { status: 'confirmed', version: 2 } },
        { new: true },
      );

      const response = await request(getTestServer(app))
        .patch(`/api/v1/measures/${confirmed!._id.toString()}`)
        .set('Cookie', cookie)
        .send({ bogus: true });

      expect(response.status).toBe(400);
    });

    it('edits a confirmed measure and bumps its version, running another rescan', async () => {
      const proposed = await createProposedMeasure();
      const confirmed = await measureModel.findOneAndUpdate(
        { _id: proposed._id },
        { $set: { status: 'confirmed', version: 2 } },
        { new: true },
      );

      const response = await request(getTestServer(app))
        .patch(`/api/v1/measures/${confirmed!._id.toString()}`)
        .set('Cookie', cookie)
        .send({ tolerance: 0.5 });
      const body = response.body as MeasureBody;

      expect(response.status).toBe(200);
      expect(body.tolerance).toBe(0.5);
      expect(body.version).toBe(3);
      expect(body.lastRescan?.status).toBe('completed');
    });
  });
});
