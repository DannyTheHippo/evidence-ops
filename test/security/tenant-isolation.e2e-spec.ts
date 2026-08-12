import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { DEFAULT_TENANT_ID } from '../../src/database/constants/tenant.constant';
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
import { User, UserDocument } from '../../src/database/schemas/administration/user/user.schema';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

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

/**
 * Proves the multi-tenancy milestone's acceptance criterion: a second tenant's data is
 * unreachable BY QUERY, not merely unrendered. Every cross-tenant read below asserts 404, never
 * 403 — a cross-tenant id must be indistinguishable from a nonexistent one, or the endpoint
 * becomes an existence oracle (mirrors the reasoning already documented on
 * `approvals.e2e-spec.ts`'s "belongs to a different tenant" case, extended here across every
 * tenant-scoped resource in one pass).
 */
describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let tokenA: string;
  let tokenB: string;
  let comps: Buffer;
  let leaseSummary: Buffer;

  let userModel: Model<UserDocument>;
  let conflictModel: Model<ConflictDocument>;
  let approvalModel: Model<ApprovalDocument>;
  let workflowRunModel: Model<WorkflowRunDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;

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

    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
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
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentialsA);
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentialsB);

    // Flip B onto its own tenant and both users to admin (POST /approvals/:id/decision is
    // admin-gated) directly on the row, then re-login both — tenant and role travel in the JWT,
    // so mutating the row without re-issuing the token would leave the existing tokens unchanged.
    await userModel.updateOne({ email: credentialsA.email }, { role: UserRole.Admin });
    await userModel.updateOne(
      { email: credentialsB.email },
      { role: UserRole.Admin, tenantId: OTHER_TENANT_ID },
    );

    const loginA = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentialsA);
    tokenA = (loginA.body as { accessToken: string }).accessToken;
    const loginB = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentialsB);
    tokenB = (loginB.body as { accessToken: string }).accessToken;

    // Seed tenant-`default` data as user A.
    const uploaded = await request(getTestServer(app))
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .field('title', 'Comparables')
      .attach('file', comps, { filename: 'comps.xlsx', contentType: XLSX_MIME });
    documentIdA = (uploaded.body as DocumentBody).id;

    const started = await request(getTestServer(app))
      .post('/api/v1/questions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ questionText: 'What is the cap rate for Northgate Business Park?' });
    answerIdA = (started.body as AnswerBody).id;

    const factLow = await extractedFactModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 5.25, unit: 'percent' },
      rawText: 'cap rate of 5.25%',
      confidence: 0.9,
      extractionMethod: 'llm',
      chunkId: 'chunk-xlsx',
      documentVersionId: new Types.ObjectId(),
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      tenantId: DEFAULT_TENANT_ID,
    });
    const factHigh = await extractedFactModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 6.1, unit: 'percent' },
      rawText: 'cap rate of 6.10%',
      confidence: 0.9,
      extractionMethod: 'llm',
      chunkId: 'chunk-prose',
      documentVersionId: new Types.ObjectId(),
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      tenantId: DEFAULT_TENANT_ID,
    });
    const conflict = await conflictModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      factIds: [factLow._id, factHigh._id],
      magnitude: 0.0085,
      status: 'open',
      tenantId: DEFAULT_TENANT_ID,
    });
    conflictIdA = conflict._id.toString();

    const approval = await approvalModel.create({
      subject: { entityType: 'Conflict', entityId: conflict._id },
      action: 'resolve_conflict',
      summary: 'Resolve Northgate Business Park cap_rate (2025-03).',
      requestedBy: credentialsA.email,
      state: 'pending',
      tenantId: DEFAULT_TENANT_ID,
    });
    approvalIdA = approval._id.toString();

    workflowIdA = `wf-tenant-isolation-${new Types.ObjectId().toString()}`;
    const workflowRun = await workflowRunModel.create({
      workflowId: workflowIdA,
      status: 'running',
      tenantId: DEFAULT_TENANT_ID,
    });
    workflowRunIdA = workflowRun._id.toString();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it("returns an empty list for tenant B's GET /documents", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns 404, not 403, for tenant B's GET /documents/:idFromA", async () => {
    const response = await request(getTestServer(app))
      .get(`/api/v1/documents/${documentIdA}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(404);
  });

  it("returns 404, not 403, for tenant B's GET /answers/:idFromA", async () => {
    const response = await request(getTestServer(app))
      .get(`/api/v1/answers/${answerIdA}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(404);
  });

  it("returns 404, not 403, for tenant B's GET /workflow-runs/:idFromA", async () => {
    const response = await request(getTestServer(app))
      .get(`/api/v1/workflow-runs/${workflowRunIdA}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(404);
  });

  it("returns an empty list for tenant B's GET /workflow-runs?workflowId=<A's workflowId>", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/workflow-runs')
      .query({ workflowId: workflowIdA })
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns an empty list for tenant B's GET /conflicts", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/conflicts')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns an empty list for tenant B's GET /approvals", async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/approvals')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ docs: [], count: 0 });
  });

  it("returns 404, not 403, for tenant B's POST /conflicts/:idFromA/resolution-requests", async () => {
    const response = await request(getTestServer(app))
      .post(`/api/v1/conflicts/${conflictIdA}/resolution-requests`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ winningFactId: new Types.ObjectId().toString() });

    expect(response.status).toBe(404);
  });

  it("returns 404, not 403, for tenant B's POST /approvals/:idFromA/decision", async () => {
    const response = await request(getTestServer(app))
      .post(`/api/v1/approvals/${approvalIdA}/decision`)
      .set('Authorization', `Bearer ${tokenB}`)
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
        .set('Authorization', `Bearer ${tokenB}`)
        .field('title', 'Lease Summary')
        .attach('file', leaseSummary, { filename: 'lease-summary.docx', contentType: DOCX_MIME });
      documentIdB = (uploaded.body as DocumentBody).id;
    });

    it('is visible to tenant B', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .set('Authorization', `Bearer ${tokenB}`);
      const body = response.body as { docs: DocumentBody[]; count: number };

      expect(body.docs.some((doc) => doc.id === documentIdB)).toBe(true);
    });

    it('is invisible to tenant default (user A)', async () => {
      const list = await request(getTestServer(app))
        .get('/api/v1/documents')
        .set('Authorization', `Bearer ${tokenA}`);
      const listBody = list.body as { docs: DocumentBody[]; count: number };
      expect(listBody.docs.some((doc) => doc.id === documentIdB)).toBe(false);

      const detail = await request(getTestServer(app))
        .get(`/api/v1/documents/${documentIdB}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(detail.status).toBe(404);
    });
  });
});
