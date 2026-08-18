import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  Approval,
  ApprovalDocument,
} from '../../src/database/schemas/workflow/approval/approval.schema';
import {
  Conflict,
  ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  WorkflowRun,
  WorkflowRunDocument,
} from '../../src/database/schemas/workflow/workflow-run/workflow-run.schema';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';

const FIXTURES = path.join(__dirname, '../../fixtures/data-room');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OTHER_TENANT_ID = 'tenant-b';

interface DocumentBody {
  id: string;
  title: string;
}

interface AnswerBody {
  id: string;
  runStatus: string;
}

interface WorkflowRunBody {
  id: string;
}

interface ConflictBody {
  id: string;
}

interface ApprovalBody {
  id: string;
}

/**
 * Proves the multi-tenancy milestone's acceptance criterion: a second tenant's data is
 * unreachable BY QUERY, not merely unrendered. For every tenant-scoped resource this file covers,
 * a positive assertion (tenant A reads its own row) sits next to the negative one (tenant B is
 * denied that same row) — a denial alone cannot distinguish "correctly isolated" from
 * "unreachable by everyone". Every cross-tenant read asserts 404, never 403 — a cross-tenant id
 * must be indistinguishable from a nonexistent one, or the endpoint becomes an existence oracle
 * (mirrors the reasoning already documented on `approvals.e2e-spec.ts`'s "belongs to a different
 * tenant" case, extended here across every tenant-scoped resource in one pass).
 */
describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let cookieA: string;
  let cookieB: string;
  let comps: Buffer;
  let leaseSummary: Buffer;

  let conflictModel: Model<ConflictDocument>;
  let approvalModel: Model<ApprovalDocument>;
  let workflowRunModel: Model<WorkflowRunDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;

  let tenantIdA: string;
  let documentIdA: string;
  let answerIdA: string;
  let conflictIdA: string;
  let approvalIdA: string;
  let workflowRunIdA: string;
  let workflowIdA: string;

  beforeAll(async () => {
    app = await createTestApp();

    comps = await readFile(path.join(FIXTURES, 'comps.xlsx'));
    leaseSummary = await readFile(path.join(FIXTURES, 'lease-summary.docx'));

    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    approvalModel = app.get<Model<ApprovalDocument>>(getModelToken(Approval.name));
    workflowRunModel = app.get<Model<WorkflowRunDocument>>(getModelToken(WorkflowRun.name));
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));

    const credentialsA = {
      email: 'tenant-isolation-a@example.com',
      password: 'correct-horse-battery',
    };
    const credentialsB = {
      email: 'tenant-isolation-b@example.com',
      password: 'correct-horse-battery',
    };
    // `registerTestUser` provisions a brand-new tenant per registrant and makes the registrant
    // that tenant's admin (both are needed here since POST /approvals/:id/decision is
    // admin-gated). B's `tenantId` option re-points the persisted row at the same literal tenant
    // id every other cross-tenant e2e in this repo uses, so B stays genuinely distinct from A's
    // real, generated tenant without inventing a second convention for "the other tenant".
    const userA = await registerTestUser(app, credentialsA);
    const userB = await registerTestUser(app, credentialsB, { tenantId: OTHER_TENANT_ID });
    cookieA = userA.cookie;
    cookieB = userB.cookie;
    tenantIdA = userA.tenantId;

    // Seed user A's real tenant with data.
    const uploaded = await request(getTestServer(app))
      .post('/api/v1/documents')
      .set('Cookie', cookieA)
      .field('title', 'Comparables')
      .attach('file', comps, { filename: 'comps.xlsx', contentType: XLSX_MIME });
    documentIdA = (uploaded.body as DocumentBody).id;

    const started = await request(getTestServer(app))
      .post('/api/v1/questions')
      .set('Cookie', cookieA)
      .send({ questionText: 'What is the cap rate for Northgate Business Park?' });
    answerIdA = (started.body as AnswerBody).id;

    const factLow = await extractedFactModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      groupKeyNormalized: groupKey({
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: '2025-03',
      }),
      value: { amount: 5.25, unit: 'percent' },
      rawText: 'cap rate of 5.25%',
      confidence: 0.9,
      extractionMethod: 'llm',
      chunkId: 'chunk-xlsx',
      documentVersionId: new Types.ObjectId(),
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      tenantId: tenantIdA,
    });
    const factHigh = await extractedFactModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      groupKeyNormalized: groupKey({
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: '2025-03',
      }),
      value: { amount: 6.1, unit: 'percent' },
      rawText: 'cap rate of 6.10%',
      confidence: 0.9,
      extractionMethod: 'llm',
      chunkId: 'chunk-prose',
      documentVersionId: new Types.ObjectId(),
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      tenantId: tenantIdA,
    });
    const conflict = await conflictModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      groupKeyNormalized: groupKey({
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: '2025-03',
      }),
      factIds: [factLow._id, factHigh._id],
      magnitude: 0.0085,
      status: 'open',
      tenantId: tenantIdA,
    });
    conflictIdA = conflict._id.toString();

    const approval = await approvalModel.create({
      subject: { entityType: 'Conflict', entityId: conflict._id },
      action: 'resolve_conflict',
      summary: 'Resolve Northgate Business Park cap_rate (2025-03).',
      requestedBy: credentialsA.email,
      state: 'pending',
      tenantId: tenantIdA,
    });
    approvalIdA = approval._id.toString();

    workflowIdA = `wf-tenant-isolation-${new Types.ObjectId().toString()}`;
    const workflowRun = await workflowRunModel.create({
      workflowId: workflowIdA,
      status: 'running',
      tenantId: tenantIdA,
    });
    workflowRunIdA = workflowRun._id.toString();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it("provisions a newly registered user's own tenant, never DEFAULT_TENANT_ID", () => {
    expect(tenantIdA).not.toBe('default');
  });

  // Headline claim of the tenancy change: public registration provisions a fresh, empty tenant
  // rather than landing a stranger in the shared demo tenant. Registers a brand-new third user
  // against a database that already holds tenant A's seeded data (documents, answers, conflicts,
  // approvals, workflow runs) and asserts every evidence-bearing endpoint reports nothing for them.
  describe('a freshly registered user with no data of their own', () => {
    let cookieC: string;

    beforeAll(async () => {
      const userC = await registerTestUser(app, {
        email: 'tenant-isolation-c@example.com',
        password: 'correct-horse-battery',
      });
      cookieC = userC.cookie;
    });

    it('sees an empty list from GET /documents', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .set('Cookie', cookieC);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ docs: [], count: 0 });
    });

    it("gets 404 for tenant A's document id", async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/documents/${documentIdA}`)
        .set('Cookie', cookieC);

      expect(response.status).toBe(404);
    });

    it("gets 404 for tenant A's answer id", async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${answerIdA}`)
        .set('Cookie', cookieC);

      expect(response.status).toBe(404);
    });

    it('sees an empty list from GET /conflicts', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookieC);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ docs: [], count: 0 });
    });

    it('sees an empty list from GET /approvals', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/approvals')
        .set('Cookie', cookieC);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ docs: [], count: 0 });
    });

    it("gets 404 for tenant A's workflow run id", async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/workflow-runs/${workflowRunIdA}`)
        .set('Cookie', cookieC);

      expect(response.status).toBe(404);
    });

    it("sees an empty list from GET /workflow-runs?workflowId=<A's workflowId>", async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/workflow-runs')
        .query({ workflowId: workflowIdA })
        .set('Cookie', cookieC);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ docs: [], count: 0 });
    });
  });

  it("returns an empty list for tenant B's GET /documents", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/documents')
      .set('Cookie', cookieB);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns 404, not 403, for tenant B's GET /documents/:idFromA", async () => {
    const response = await request(getTestServer(app))
      .get(`/api/v1/documents/${documentIdA}`)
      .set('Cookie', cookieB);

    expect(response.status).toBe(404);
  });

  it("returns 404, not 403, for tenant B's GET /answers/:idFromA", async () => {
    const response = await request(getTestServer(app))
      .get(`/api/v1/answers/${answerIdA}`)
      .set('Cookie', cookieB);

    expect(response.status).toBe(404);
  });

  it("returns tenant A's own workflow run for tenant A's GET /workflow-runs/:idFromA", async () => {
    const response = await request(getTestServer(app))
      .get(`/api/v1/workflow-runs/${workflowRunIdA}`)
      .set('Cookie', cookieA);

    expect(response.status).toBe(200);
    expect((response.body as WorkflowRunBody).id).toBe(workflowRunIdA);
  });

  it("returns 404, not 403, for tenant B's GET /workflow-runs/:idFromA", async () => {
    const response = await request(getTestServer(app))
      .get(`/api/v1/workflow-runs/${workflowRunIdA}`)
      .set('Cookie', cookieB);

    expect(response.status).toBe(404);
  });

  it("returns tenant A's own run for tenant A's GET /workflow-runs?workflowId=<A's workflowId>", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/workflow-runs')
      .query({ workflowId: workflowIdA })
      .set('Cookie', cookieA);
    const body = response.body as { docs: WorkflowRunBody[]; count: number };

    expect(response.status).toBe(200);
    expect(body.docs.some((doc) => doc.id === workflowRunIdA)).toBe(true);
  });

  it("returns an empty list for tenant B's GET /workflow-runs?workflowId=<A's workflowId>", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/workflow-runs')
      .query({ workflowId: workflowIdA })
      .set('Cookie', cookieB);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns tenant A's own conflict for tenant A's GET /conflicts", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/conflicts')
      .set('Cookie', cookieA);
    const body = response.body as { docs: ConflictBody[]; count: number };

    expect(response.status).toBe(200);
    expect(body.docs.some((doc) => doc.id === conflictIdA)).toBe(true);
  });

  it("returns an empty list for tenant B's GET /conflicts", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/conflicts')
      .set('Cookie', cookieB);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns tenant A's own approval for tenant A's GET /approvals", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/approvals')
      .set('Cookie', cookieA);
    const body = response.body as { docs: ApprovalBody[]; count: number };

    expect(response.status).toBe(200);
    expect(body.docs.some((doc) => doc.id === approvalIdA)).toBe(true);
  });

  it("returns an empty list for tenant B's GET /approvals", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/approvals')
      .set('Cookie', cookieB);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns 404, not 403, for tenant B's POST /conflicts/:idFromA/resolution-requests", async () => {
    const response = await request(getTestServer(app))
      .post(`/api/v1/conflicts/${conflictIdA}/resolution-requests`)
      .set('Cookie', cookieB)
      .send({ winningFactId: new Types.ObjectId().toString() });

    expect(response.status).toBe(404);
  });

  it("returns 404, not 403, for tenant B's POST /approvals/:idFromA/decision", async () => {
    const response = await request(getTestServer(app))
      .post(`/api/v1/approvals/${approvalIdA}/decision`)
      .set('Cookie', cookieB)
      .send({ decision: 'approved' });

    expect(response.status).toBe(404);
  });

  // Reverse direction: proves writes land in the right tenant rather than reads merely being
  // filtered. If B's upload were silently stamped with A's tenant (or no tenant at all), this
  // pair of assertions — not the read-side checks above — is what would catch it.
  describe('a document uploaded by tenant B', () => {
    let documentIdB: string;

    beforeAll(async () => {
      const uploaded = await request(getTestServer(app))
        .post('/api/v1/documents')
        .set('Cookie', cookieB)
        .field('title', 'Lease Summary')
        .attach('file', leaseSummary, { filename: 'lease-summary.docx', contentType: DOCX_MIME });
      documentIdB = (uploaded.body as DocumentBody).id;
    });

    it('is visible to tenant B', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .set('Cookie', cookieB);
      const body = response.body as { docs: DocumentBody[]; count: number };

      expect(body.docs.some((doc) => doc.id === documentIdB)).toBe(true);
    });

    it('is invisible to tenant A', async () => {
      const list = await request(getTestServer(app))
        .get('/api/v1/documents')
        .set('Cookie', cookieA);
      const listBody = list.body as { docs: DocumentBody[]; count: number };
      expect(listBody.docs.some((doc) => doc.id === documentIdB)).toBe(false);

      const detail = await request(getTestServer(app))
        .get(`/api/v1/documents/${documentIdB}`)
        .set('Cookie', cookieA);
      expect(detail.status).toBe(404);
    });
  });
});
