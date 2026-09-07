import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../src/database/schemas/audit/audit-event/audit-event.schema';
import { Answer, AnswerDocument } from '../../src/database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  WorkflowRun,
  WorkflowRunDocument,
} from '../../src/database/schemas/workflow/workflow-run/workflow-run.schema';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';
import {
  ACTIVE_PACK_ID,
  ACTIVE_PACK_VERSION,
  METRIC_IDS,
} from '../../src/features/evidence/facts/metric-ontology';
import type { Citation } from '../../src/features/evidence/qa/contracts/answer.contract';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

describe('Serialization (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const credentials = {
    email: 'serialization-e2e@example.com',
    password: 'correct-horse-battery-staple',
  };

  // Regression test for the `excludeExtraneousValues` fix: only fields declared @Expose on
  // the response DTOs may reach the client, so the raw password/hash can never leak.
  it('never exposes the password or its hash in the register response', async () => {
    const response = await request(getTestServer(app))
      .post('/api/v1/auth/register')
      .send(credentials);
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
    // Exact-key assertion: the only gate catching a MeResponseDto field missing @Expose().
    expect(Object.keys(body).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  it('never exposes the password or its hash in the login response, including the nested user', async () => {
    const response = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    const body = response.body as { accessToken: string; user: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
    expect(Object.keys(body.user).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  // Regression for the inventory fields (D8): a response DTO field without @Expose() is dropped
  // silently, with no error anywhere — this is the gate that catches it for the four new Source
  // fields plus the previously write-only-by-accident sourceClass.
  it('exposes every Source inventory field in the create response', async () => {
    const { cookie } = await registerTestUser(app, {
      email: 'serialization-sources-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const response = await request(getTestServer(app))
      .post('/api/v1/sources')
      .set('Cookie', cookie)
      .send({
        name: `Serialization Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        owner: 'Jane Doe, IT',
        connectivity: 'export-only',
        reachability: 'possible',
        tracked: false,
        sourceClass: 'crm-export',
      });
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.connectivity).toBe('export-only');
    expect(body.reachability).toBe('possible');
    expect(body.owner).toBe('Jane Doe, IT');
    expect(body.tracked).toBe(false);
    expect(body.sourceClass).toBe('crm-export');
  });

  // Regression for the write-only audit fields (M1, plus modifiedCount found in the same class of
  // gap after M1 landed): `origin`, `toolName`, `refusalReason` and `modifiedCount` are written by
  // AuditService and persisted by the schema, but were readable through no DTO — this is the gate
  // that catches any of the four losing its @Expose() again.
  it('exposes origin, toolName and refusalReason in the audit-events list response', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-audit-events-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    const action = `serialization-e2e.mcp-refusal-${Date.now()}`;
    await auditEventModel.create({
      actor: new Types.ObjectId(),
      action,
      subject: { entityType: 'Answer', entityId: new Types.ObjectId() },
      timestamp: new Date(),
      correlationId: 'corr-serialization-e2e',
      origin: 'mcp',
      toolName: 'get_answer',
      refusalReason: 'authz-denied',
      tenantId,
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/audit-events')
      .query({ action })
      .set('Cookie', cookie);
    const body = response.body as { docs: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].origin).toBe('mcp');
    expect(body.docs[0].toolName).toBe('get_answer');
    expect(body.docs[0].refusalReason).toBe('authz-denied');
  });

  it('exposes modifiedCount in the audit-events list response', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-audit-events-modified-count-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    const action = 'sources.class_drift_applied';
    await auditEventModel.create({
      actor: new Types.ObjectId(),
      action,
      subject: { entityType: 'Source', entityId: new Types.ObjectId() },
      timestamp: new Date(),
      correlationId: 'corr-serialization-modified-count-e2e',
      origin: 'api',
      modifiedCount: 400,
      tenantId,
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/audit-events')
      .query({ action, entityType: 'Source' })
      .set('Cookie', cookie);
    const body = response.body as { docs: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].modifiedCount).toBe(400);
  });

  // Regression for the same class of gap: `withdrawnCitedDocVersionIds` is computed at read time
  // (never persisted), so it is easy for a response DTO field of this shape to lose its @Expose()
  // without a failing type-check anywhere. Also proves the join tags only the cited version that
  // actually carries `withdrawnAt`, not every citation on the answer.
  it('exposes withdrawnCitedDocVersionIds on the answer response, naming only the citation whose version carries withdrawnAt', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-withdrawn-citation-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
    const answerModel = app.get<Model<AnswerDocument>>(getModelToken(Answer.name));

    const withdrawnVersion = await documentVersionModel.create({
      tenantId,
      documentId: new Types.ObjectId(),
      versionNumber: 1,
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      storageKey: 'serialization-withdrawn-citation-e2e',
      withdrawnAt: new Date(),
      withdrawnReason: 'source-file-absent',
    });
    const liveVersion = await documentVersionModel.create({
      tenantId,
      documentId: new Types.ObjectId(),
      versionNumber: 1,
      sha256: 'b'.repeat(64),
      sizeBytes: 100,
      storageKey: 'serialization-live-citation-e2e',
    });

    const withdrawnCitation: Citation = {
      docVersionId: withdrawnVersion._id.toString(),
      sha256: 'a'.repeat(64),
      chunkId: 'chunk-withdrawn',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      quote: 'evidence from a since-withdrawn source',
    };
    const liveCitation: Citation = {
      docVersionId: liveVersion._id.toString(),
      sha256: 'b'.repeat(64),
      chunkId: 'chunk-live',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      quote: 'evidence from a source still in the corpus',
    };
    const seeded = await answerModel.create({
      tenantId,
      questionText: 'What is the cap rate?',
      runStatus: 'completed',
      outcome: {
        kind: 'answered',
        claims: [
          { statement: 'Statement one.', citations: [withdrawnCitation] },
          { statement: 'Statement two.', citations: [liveCitation] },
        ],
      },
      claims: [
        { statement: 'Statement one.', citations: [withdrawnCitation] },
        { statement: 'Statement two.', citations: [liveCitation] },
      ],
      claimCoverage: 1,
    });

    const response = await request(getTestServer(app))
      .get(`/api/v1/answers/${seeded._id.toString()}`)
      .set('Cookie', cookie);
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body)).toContain('withdrawnCitedDocVersionIds');
    expect(body.withdrawnCitedDocVersionIds).toEqual([withdrawnVersion._id.toString()]);
  });

  // Regression for the grounding-gate persistence fix: `outcome.claims` on a persisted `answered`
  // Answer is the gate's own survivor set, never a model claim the gate already dropped — this
  // seeds an Answer the way `groundingCheck`/`AnswerPersistenceService` now produce one (one
  // surviving claim, one dropped, `verifiedClaimCount` below `totalClaimCount`) and asserts the
  // response only ever surfaces the survivor, with the exact `outcome` key set catching a
  // dropped-claim field re-added with no @Expose().
  it('serializes an answered outcome with 0 < verifiedClaimCount < totalClaimCount to only the surviving claim, never the dropped one', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-partial-verification-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const answerModel = app.get<Model<AnswerDocument>>(getModelToken(Answer.name));

    const survivingCitation: Citation = {
      docVersionId: 'version-surviving',
      sha256: 'a'.repeat(64),
      chunkId: 'chunk-surviving',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      quote: 'the surviving citation quote',
    };
    const seeded = await answerModel.create({
      tenantId,
      questionText: 'What is the cap rate and the vacancy rate?',
      runStatus: 'completed',
      outcome: {
        kind: 'answered',
        claims: [{ statement: 'The cap rate is 6.1%.', citations: [survivingCitation] }],
      },
      claims: [{ statement: 'The cap rate is 6.1%.', citations: [survivingCitation] }],
      claimCoverage: 0.5,
      atoms: [
        { claimIndex: 0, statement: 'The cap rate is 6.1%.', atoms: ['The cap rate is 6.1%.'] },
      ],
      verificationReport: {
        verifiedClaimCount: 1,
        totalClaimCount: 2,
        droppedClaims: [
          { statement: 'The vacancy rate is 4%.', reason: 'quote did not match the source chunk' },
        ],
        atomization: {
          decomposedClaimCount: 1,
          coverageFallbackCount: 0,
          atomDroppedClaimCount: 0,
          contradictionDroppedClaimCount: 0,
        },
      },
    });

    const response = await request(getTestServer(app))
      .get(`/api/v1/answers/${seeded._id.toString()}`)
      .set('Cookie', cookie);
    const body = response.body as {
      outcome: { kind: string; claims: Array<{ statement: string }> };
      citations: Citation[];
      atoms: Array<{ claimIndex: number; statement: string; atoms: string[] }>;
      verificationReport: {
        verifiedClaimCount: number;
        totalClaimCount: number;
        atomization: Record<string, number>;
      };
    };

    expect(response.status).toBe(200);
    expect(Object.keys(body.outcome).sort()).toEqual(['kind', 'claims'].sort());
    expect(body.outcome.claims).toHaveLength(1);
    expect(body.outcome.claims[0].statement).toBe('The cap rate is 6.1%.');
    expect(body.outcome.claims.map((claim) => claim.statement)).not.toContain(
      'The vacancy rate is 4%.',
    );
    expect(body.citations).toEqual([survivingCitation]);
    expect(body.verificationReport.verifiedClaimCount).toBe(1);
    expect(body.verificationReport.totalClaimCount).toBe(2);
    // Regression for the atomization gap: `atoms` and `verificationReport.atomization` are
    // computed alongside the grounding gate but read through a separate DTO nesting — this is the
    // gate that catches either losing its @Expose().
    expect(body.atoms).toEqual([
      { claimIndex: 0, statement: 'The cap rate is 6.1%.', atoms: ['The cap rate is 6.1%.'] },
    ]);
    expect(Object.keys(body.verificationReport.atomization).sort()).toEqual(
      [
        'decomposedClaimCount',
        'coverageFallbackCount',
        'atomDroppedClaimCount',
        'contradictionDroppedClaimCount',
      ].sort(),
    );
  });

  // Regression for the metric-label gap: four SPA surfaces render a raw METRIC_IDS value with no
  // way to show a human label — this is the gate that catches MetricResponseDto losing an
  // @Expose() or the projection dropping a confirmed measure. The id order matters beyond
  // cosmetics: it is the seeded ordering the prose extractor's cached prompt hash depends on, so a
  // freshly registered tenant's response must reproduce METRIC_IDS in order, byte-for-byte.
  it('exposes the tenant confirmed measures as id, label, canonicalUnit, in seeded order, on GET /metrics', async () => {
    const { cookie } = await registerTestUser(app, {
      email: 'serialization-metrics-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const response = await request(getTestServer(app)).get('/api/v1/metrics').set('Cookie', cookie);
    const body = response.body as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(body.map((metric) => metric.id)).toEqual([...METRIC_IDS]);
    for (const metric of body) {
      expect(Object.keys(metric).sort()).toEqual(['canonicalUnit', 'id', 'label']);
    }
    const capRate = body.find((metric) => metric.id === 'cap_rate');
    expect(capRate?.label).toBe('Cap Rate');
    expect(capRate?.canonicalUnit).toBe('ratio');
  });

  // Regression for the write-only magnitudeUnit gap: a cap-rate spread and a dollar spread both
  // rendered as an identical bare number with no @Expose() on this field.
  it('exposes magnitudeUnit in the conflicts list response', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-conflicts-magnitude-unit-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    const factKey = {
      entity: 'Serialization Test Property',
      metric: 'cap_rate',
      period: '2025-03',
    };
    await conflictModel.create({
      tenantId,
      factKey,
      groupKeyNormalized: groupKey(factKey),
      factIds: [new Types.ObjectId(), new Types.ObjectId()],
      magnitude: 0.0085,
      magnitudeUnit: 'ratio',
      packId: ACTIVE_PACK_ID,
      packVersion: ACTIVE_PACK_VERSION,
      status: 'open',
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/conflicts')
      .set('Cookie', cookie);
    const body = response.body as { docs: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].magnitudeUnit).toBe('ratio');
  });

  // Regression for the workflow-runs list widening: subjectId/subjectType are computed fields
  // (never spread from the schema document), and status/workflowType are new query filters — this
  // is the gate that catches either losing its @Expose()/validator decorator, and proves the
  // filters actually narrow the list rather than being silently dropped as unwhitelisted.
  it('exposes subjectId and subjectType in the workflow-runs list response and filters by status and workflowType', async () => {
    const { cookie, tenantId } = await registerTestUser(app, {
      email: 'serialization-workflow-runs-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const workflowRunModel = app.get<Model<WorkflowRunDocument>>(getModelToken(WorkflowRun.name));
    const subjectId = new Types.ObjectId();
    const matching = await workflowRunModel.create({
      tenantId,
      workflowId: 'wf-serialization-e2e-match',
      workflowType: 'resolve-conflict',
      status: 'failed',
      subjectId,
      subjectType: 'Conflict',
    });
    await workflowRunModel.create({
      tenantId,
      workflowId: 'wf-serialization-e2e-other',
      workflowType: 'sync-source',
      status: 'running',
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/workflow-runs')
      .query({ status: 'failed', workflowType: 'resolve-conflict' })
      .set('Cookie', cookie);
    const body = response.body as { docs: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].id).toBe(matching._id.toString());
    expect(body.docs[0].subjectId).toBe(subjectId.toString());
    expect(body.docs[0].subjectType).toBe('Conflict');
  });
});
