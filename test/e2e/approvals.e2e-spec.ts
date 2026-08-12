import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { DEFAULT_TENANT_ID } from '../../src/database/constants/tenant.constant';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../src/database/schemas/audit/audit-event/audit-event.schema';
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
import { FakeWorkflowEngine } from '../../src/providers/workflow-engine/fake-workflow.engine';
import { WORKFLOW_ENGINE } from '../../src/providers/workflow-engine/workflow-engine.interface';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

interface ApprovalBody {
  id: string;
  subject: { entityType: string; entityId: string };
  action: string;
  summary: string;
  requestedBy?: string;
  workflowId?: string;
  state: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
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

describe('Approvals, WorkflowRuns, and Conflict resolution requests (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let adminToken: string;
  let fakeWorkflowEngine: FakeWorkflowEngine;
  let approvalModel: Model<ApprovalDocument>;
  let workflowRunModel: Model<WorkflowRunDocument>;
  let conflictModel: Model<ConflictDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let auditEventModel: Model<AuditEventDocument>;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    app = await createTestApp();
    fakeWorkflowEngine = app.get<FakeWorkflowEngine>(WORKFLOW_ENGINE);

    const credentials = { email: 'approvals-e2e@example.com', password: 'correct-horse-battery' };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentials);
    const login = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    token = (login.body as { accessToken: string }).accessToken;

    approvalModel = app.get<Model<ApprovalDocument>>(getModelToken(Approval.name));
    workflowRunModel = app.get<Model<WorkflowRunDocument>>(getModelToken(WorkflowRun.name));
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));
    auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));

    // POST /approvals/:id/decision is admin-gated; a freshly-registered user defaults to
    // `member`. Flip the row directly, then re-login — the role travels in the JWT, so flipping
    // the row without re-issuing the token would leave the existing `token` unchanged.
    const adminCredentials = {
      email: 'approvals-admin-e2e@example.com',
      password: 'correct-horse-battery',
    };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(adminCredentials);
    await userModel.updateOne({ email: adminCredentials.email }, { role: UserRole.Admin });
    const adminLogin = await request(getTestServer(app))
      .post('/api/v1/auth/login')
      .send(adminCredentials);
    adminToken = (adminLogin.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const seedConflictWithFacts = async () => {
    const factLow = await extractedFactModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 5.25, unit: 'percent' },
      rawText: 'cap rate of 5.25%',
      confidence: 0.9,
      extractionMethod: 'llm',
      chunkId: 'chunk-xlsx',
      documentVersionId: new Types.ObjectId(),
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
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
    });
    const conflict = await conflictModel.create({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      factIds: [factLow._id, factHigh._id],
      magnitude: 0.0085,
      status: 'open',
    });

    return { conflict, factLow, factHigh };
  };

  describe('POST /conflicts/:id/resolution-requests', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).post(
        `/api/v1/conflicts/${new Types.ObjectId().toString()}/resolution-requests`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 404 for an unknown conflict', async () => {
      const response = await request(getTestServer(app))
        .post(`/api/v1/conflicts/${new Types.ObjectId().toString()}/resolution-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({ winningFactId: new Types.ObjectId().toString() });

      expect(response.status).toBe(404);
    });

    it("returns 409 when winningFactId is not one of the conflict's own facts", async () => {
      const { conflict } = await seedConflictWithFacts();

      const response = await request(getTestServer(app))
        .post(`/api/v1/conflicts/${conflict._id.toString()}/resolution-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({ winningFactId: new Types.ObjectId().toString() });

      expect(response.status).toBe(409);
    });

    it('starts the resolveConflict workflow and records a WorkflowRun, exposing the exact key set', async () => {
      const { conflict, factLow } = await seedConflictWithFacts();
      const startedBefore = fakeWorkflowEngine.started.length;

      const response = await request(getTestServer(app))
        .post(`/api/v1/conflicts/${conflict._id.toString()}/resolution-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({ winningFactId: factLow._id.toString() });
      const body = response.body as WorkflowRunBody;

      expect(response.status).toBe(201);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body).sort()).toEqual(['id', 'workflowId', 'status', 'createdAt'].sort());

      expect(fakeWorkflowEngine.started).toHaveLength(startedBefore + 1);
      const started = fakeWorkflowEngine.started[fakeWorkflowEngine.started.length - 1];
      expect(started.workflowType).toBe('resolveConflict');
      expect(started.input).toEqual({
        conflictId: conflict._id.toString(),
        winningFactId: factLow._id.toString(),
        requestedBy: 'approvals-e2e@example.com',
        tenantId: DEFAULT_TENANT_ID,
      });

      const stored = await workflowRunModel.findById(body.id);
      expect(stored?.workflowId).toBe(body.workflowId);

      const events = await auditEventModel.find({
        action: 'conflicts.resolution_requested',
        'subject.entityId': conflict._id,
      });
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('GET /approvals', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/approvals');

      expect(response.status).toBe(401);
    });

    it('lists only pending approvals for this tenant, exposing the exact key set of a fresh row', async () => {
      const pending = await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'resolve_conflict',
        summary: 'Resolve Northgate Business Park cap_rate (2025-03).',
        requestedBy: 'analyst@example.com',
        workflowId: 'wf-list-1',
        state: 'pending',
      });
      await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'resolve_conflict',
        summary: 'Already decided.',
        state: 'approved',
        decidedBy: 'reviewer@example.com',
        decidedAt: new Date(),
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/approvals')
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as { docs: ApprovalBody[]; count: number };

      expect(response.status).toBe(200);
      const listed = body.docs.find((doc) => doc.id === pending._id.toString());
      expect(listed).toBeDefined();
      expect(listed?.workflowId).toBe('wf-list-1');
      expect(body.docs.every((doc) => doc.state === 'pending')).toBe(true);
      // A fresh pending row has no decision yet — decidedBy/decidedAt/decisionReason must be
      // entirely absent (not present-but-null), which `toEqual`-on-key-set below proves.
      expect(Object.keys(listed as object).sort()).toEqual(
        [
          'id',
          'subject',
          'action',
          'summary',
          'requestedBy',
          'workflowId',
          'state',
          'createdAt',
        ].sort(),
      );

      const events = await auditEventModel.find({ action: 'approvals.listed' });
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('POST /approvals/:id/decision', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post(`/api/v1/approvals/${new Types.ObjectId().toString()}/decision`)
        .send({ decision: 'approved' });

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin', async () => {
      const response = await request(getTestServer(app))
        .post(`/api/v1/approvals/${new Types.ObjectId().toString()}/decision`)
        .set('Authorization', `Bearer ${token}`)
        .send({ decision: 'approved' });

      expect(response.status).toBe(403);
      // objectContaining, not toEqual: GlobalExceptionFilter also attaches `stack` below
      // prod-like environments, which is a debugging aid unrelated to what this guard asserts.
      expect(response.body).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message: 'Insufficient role for this action',
          error: 'Forbidden',
        }),
      );
    });

    it('returns 404 for an unknown approval', async () => {
      const response = await request(getTestServer(app))
        .post(`/api/v1/approvals/${new Types.ObjectId().toString()}/decision`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' });

      expect(response.status).toBe(404);
    });

    // Tenant scoping (D3 item 6): an approval that belongs to a different tenant must not be
    // decidable by guessing its id — `getDecision`/`listPending` scope reads, and `decide` must
    // scope its lookup too, or one tenant could decide another's approval.
    it('returns 404 for an approval that belongs to a different tenant', async () => {
      const otherTenantApproval = await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'resolve_conflict',
        summary: 'Belongs to another tenant.',
        state: 'pending',
        tenantId: 'other-tenant',
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/approvals/${otherTenantApproval._id.toString()}/decision`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' });

      expect(response.status).toBe(404);
    });

    it('returns 409 when the approval was already decided', async () => {
      const decided = await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'resolve_conflict',
        summary: 'Already decided.',
        state: 'approved',
        decidedBy: 'reviewer@example.com',
        decidedAt: new Date(),
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/approvals/${decided._id.toString()}/decision`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' });

      expect(response.status).toBe(409);
    });

    it('decides an approval with no workflowId, persisting the decision without signalling', async () => {
      const pending = await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'resolve_conflict',
        summary: 'No workflow to wake.',
        requestedBy: 'analyst@example.com',
        state: 'pending',
      });
      const signalsBefore = fakeWorkflowEngine.signals.length;

      const response = await request(getTestServer(app))
        .post(`/api/v1/approvals/${pending._id.toString()}/decision`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved', reason: 'Evidence checks out.' });
      const body = response.body as ApprovalBody;

      expect(response.status).toBe(200);
      expect(body.state).toBe('approved');
      expect(body.decidedBy).toBe('approvals-admin-e2e@example.com');
      expect(body.decisionReason).toBe('Evidence checks out.');
      expect(Object.keys(body).sort()).toEqual(
        [
          'id',
          'subject',
          'action',
          'summary',
          'requestedBy',
          'state',
          'decidedBy',
          'decidedAt',
          'decisionReason',
          'createdAt',
        ].sort(),
      );
      expect(fakeWorkflowEngine.signals).toHaveLength(signalsBefore);
    });

    it('persists the decision and signals the workflow that requested it, waking it', async () => {
      const handle = await fakeWorkflowEngine.start('resolveConflict', {});
      const pending = await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'resolve_conflict',
        summary: 'Gated on a live workflow.',
        requestedBy: 'analyst@example.com',
        state: 'pending',
        workflowId: handle.id,
      });

      const response = await request(getTestServer(app))
        .post(`/api/v1/approvals/${pending._id.toString()}/decision`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ decision: 'approved' });
      const body = response.body as ApprovalBody;

      expect(response.status).toBe(200);
      expect(body.state).toBe('approved');
      expect(body.workflowId).toBe(handle.id);

      const signal = fakeWorkflowEngine.signals.find((s) => s.id === handle.id);
      expect(signal).toBeDefined();
      expect(signal?.signalName).toBe('approvalDecision');

      // Persist-then-signal: by the time the signal above was recorded, the durable row already
      // held the decision — the same ordering `ApprovalsService.decide` documents as the fix for
      // the "workflow wakes to a still-pending row" race.
      const stored = await approvalModel.findById(pending._id);
      expect(stored?.state).toBe('approved');
    });
  });

  describe('GET /workflow-runs/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get(
        `/api/v1/workflow-runs/${new Types.ObjectId().toString()}`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 404 for an unknown workflow run', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/workflow-runs/${new Types.ObjectId().toString()}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });

    it('refreshes the status from the live engine and exposes the exact key set, recording an audit event', async () => {
      const handle = await fakeWorkflowEngine.start('resolveConflict', {});
      fakeWorkflowEngine.setStatus(handle.id, 'completed');
      const run = await workflowRunModel.create({ workflowId: handle.id, status: 'running' });

      const response = await request(getTestServer(app))
        .get(`/api/v1/workflow-runs/${run._id.toString()}`)
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as WorkflowRunBody;

      expect(response.status).toBe(200);
      expect(body.status).toBe('completed');
      expect(Object.keys(body).sort()).toEqual(['id', 'workflowId', 'status', 'createdAt'].sort());

      const events = await auditEventModel.find({
        action: 'workflow-runs.viewed',
        'subject.entityId': run._id,
      });
      expect(events.length).toBeGreaterThan(0);
    });

    it('fails open to the durable status when the workflow id is unknown to the live engine', async () => {
      const run = await workflowRunModel.create({
        workflowId: 'unregistered-workflow-id',
        status: 'running',
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/workflow-runs/${run._id.toString()}`)
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as WorkflowRunBody;

      expect(response.status).toBe(200);
      expect(body.status).toBe('running');
    });
  });

  describe('GET /workflow-runs', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/workflow-runs');

      expect(response.status).toBe(401);
    });

    it('returns 400 when workflowId is missing', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/workflow-runs')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(400);
    });

    it('lists runs by workflowId for this tenant, exposing the exact key set, and excludes a run belonging to a different tenant', async () => {
      const workflowId = `wf-list-${new Types.ObjectId().toString()}`;
      const run = await workflowRunModel.create({ workflowId, status: 'running' });
      await workflowRunModel.create({ workflowId, status: 'running', tenantId: 'other-tenant' });

      const response = await request(getTestServer(app))
        .get('/api/v1/workflow-runs')
        .query({ workflowId })
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as { docs: WorkflowRunBody[]; count: number };

      expect(response.status).toBe(200);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBe(1);
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].id).toBe(run._id.toString());
      expect(Object.keys(body.docs[0]).sort()).toEqual(
        ['id', 'workflowId', 'status', 'createdAt'].sort(),
      );

      const events = await auditEventModel.find({ action: 'workflow-runs.listed' });
      expect(events.length).toBeGreaterThan(0);
    });
  });

  // Placed at the very end of this suite deliberately: the per-handler throttle bucket persists
  // across every earlier `decide` call above, so exhausting it here would 429 those tests if this
  // block ran before them.
  describe('POST /approvals/:id/decision throttling', () => {
    it('returns 429 after exceeding the stricter decision throttle', async () => {
      const unknownId = new Types.ObjectId().toString();
      let lastStatus: number | undefined;

      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await request(getTestServer(app))
          .post(`/api/v1/approvals/${unknownId}/decision`)
          .set('Authorization', `Bearer ${token}`)
          .send({ decision: 'approved' });
        lastStatus = response.status;
      }

      expect(lastStatus).toBe(429);
    });
  });
});
