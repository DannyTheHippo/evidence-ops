import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { Answer, AnswerDocument } from '../../src/database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  DocumentDocument,
} from '../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
  type DocumentVersionIngestionStatus,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import { Source, SourceDocument } from '../../src/database/schemas/evidence/source/source.schema';
import {
  Approval,
  ApprovalDocument,
} from '../../src/database/schemas/workflow/approval/approval.schema';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface DashboardSummaryBody {
  pendingApprovalCount: number;
  openConflictCount: number;
  documentCount: number;
  sourceCount: number;
  ingestionFailedCount: number;
  syncFailedCount: number;
  needsOcrCount: number;
  factsFailedCount: number;
  answerCount: number;
  hasIngestedDocument: boolean;
}

describe('Dashboard (e2e)', () => {
  let app: INestApplication;
  let tenantId: string;
  let approvalModel: Model<ApprovalDocument>;
  let conflictModel: Model<ConflictDocument>;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let sourceModel: Model<SourceDocument>;
  let answerModel: Model<AnswerDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    approvalModel = app.get<Model<ApprovalDocument>>(getModelToken(Approval.name));
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
    sourceModel = app.get<Model<SourceDocument>>(getModelToken(Source.name));
    answerModel = app.get<Model<AnswerDocument>>(getModelToken(Answer.name));

    const admin = await registerTestUser(app, {
      email: 'dashboard-admin-e2e@example.com',
      password: 'correct-horse-battery',
    });
    tenantId = admin.tenantId;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  // Direct model writes, following `documents.e2e-spec.ts`'s `seedDocumentWithVersion` pattern —
  // no route creates a version with an arbitrary ingestion status, ingestion does, and this
  // suite only needs rows to exist under it, not a real ingest run.
  const seedDocumentWithVersion = async (
    title: string,
    overrides: { ingestionStatus?: DocumentVersionIngestionStatus; tenantId?: string } = {},
  ) => {
    const { tenantId: overrideTenantId, ...versionOverrides } = overrides;
    const docTenantId = overrideTenantId ?? tenantId;
    const document = await documentModel.create({
      title,
      sourceKind: 'txt',
      mimeType: 'text/plain',
      tenantId: docTenantId,
    });
    const version = await documentVersionModel.create({
      documentId: document._id,
      versionNumber: 1,
      sha256: createHash('sha256').update(title).digest('hex'),
      sizeBytes: 1,
      storageKey: `seed-${title}`,
      tenantId: docTenantId,
      ...versionOverrides,
    });
    document.currentVersionId = version._id;
    await document.save();
    return document;
  };

  describe('GET /dashboard/summary', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/dashboard/summary');

      expect(response.status).toBe(401);
    });

    it('reports a zeroed, false summary for a tenant with nothing yet, exposing the exact key set', async () => {
      const freshTenant = await registerTestUser(app, {
        email: 'dashboard-empty-e2e@example.com',
        password: 'correct-horse-battery',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', freshTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(response.status).toBe(200);
      expect(body).toEqual({
        pendingApprovalCount: 0,
        openConflictCount: 0,
        documentCount: 0,
        sourceCount: 0,
        ingestionFailedCount: 0,
        syncFailedCount: 0,
        needsOcrCount: 0,
        factsFailedCount: 0,
        answerCount: 0,
        hasIngestedDocument: false,
      });
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body).sort()).toEqual(
        [
          'pendingApprovalCount',
          'openConflictCount',
          'documentCount',
          'sourceCount',
          'ingestionFailedCount',
          'syncFailedCount',
          'needsOcrCount',
          'factsFailedCount',
          'answerCount',
          'hasIngestedDocument',
        ].sort(),
      );
    });

    it('counts only pending approvals, ignoring an already-decided one', async () => {
      const scopeTenant = await registerTestUser(app, {
        email: 'dashboard-approvals-e2e@example.com',
        password: 'correct-horse-battery',
      });
      await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'conflict.resolve',
        summary: 'Pending approval',
        tenantId: scopeTenant.tenantId,
      });
      await approvalModel.create({
        subject: { entityType: 'Conflict', entityId: new Types.ObjectId() },
        action: 'conflict.resolve',
        summary: 'Already decided',
        state: 'approved',
        tenantId: scopeTenant.tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', scopeTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(body.pendingApprovalCount).toBe(1);
    });

    it('counts only open conflicts, ignoring a dismissed one', async () => {
      const scopeTenant = await registerTestUser(app, {
        email: 'dashboard-conflicts-e2e@example.com',
        password: 'correct-horse-battery',
      });
      const conflictFields = {
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        groupKeyNormalized: 'northgate|cap_rate|2025-03',
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        magnitude: 0.0085,
        magnitudeUnit: 'ratio',
        packId: 'cre',
        packVersion: 1,
        tenantId: scopeTenant.tenantId,
      };
      await conflictModel.create({ ...conflictFields, status: 'open' });
      await conflictModel.create({ ...conflictFields, status: 'dismissed' });

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', scopeTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(body.openConflictCount).toBe(1);
    });

    it('counts documents by their CURRENT version status, excluding a superseded failure', async () => {
      const scopeTenant = await registerTestUser(app, {
        email: 'dashboard-documents-e2e@example.com',
        password: 'correct-horse-battery',
      });
      const seed = (title: string, ingestionStatus?: DocumentVersionIngestionStatus) =>
        seedDocumentWithVersion(title, { ingestionStatus, tenantId: scopeTenant.tenantId });
      await seed('failed-doc', 'failed');
      await seed('needs-ocr-doc', 'needs-ocr');
      await seed('facts-failed-doc', 'facts-failed');
      // Its version list carries a 'failed' row, but the CURRENT version is a later 'completed'
      // one — must not count toward ingestionFailedCount.
      const superseded = await seed('superseded-doc', 'failed');
      const goodVersion = await documentVersionModel.create({
        documentId: superseded._id,
        versionNumber: 2,
        sha256: createHash('sha256').update('superseded-doc-v2').digest('hex'),
        sizeBytes: 1,
        storageKey: 'seed-superseded-doc-v2',
        tenantId: scopeTenant.tenantId,
        ingestionStatus: 'completed',
      });
      superseded.currentVersionId = goodVersion._id;
      await superseded.save();

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', scopeTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(body.documentCount).toBe(4);
      expect(body.ingestionFailedCount).toBe(1);
      expect(body.needsOcrCount).toBe(1);
      expect(body.factsFailedCount).toBe(1);
      expect(body.hasIngestedDocument).toBe(true);
    });

    it('reports hasIngestedDocument false when no document has a completed current version', async () => {
      const scopeTenant = await registerTestUser(app, {
        email: 'dashboard-no-completed-e2e@example.com',
        password: 'correct-horse-battery',
      });
      await seedDocumentWithVersion('only-failed-doc', {
        ingestionStatus: 'failed',
        tenantId: scopeTenant.tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', scopeTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(body.hasIngestedDocument).toBe(false);
    });

    // Regression for the bug this endpoint exists to fix: the prior client-side check scanned
    // only the first, newest-sorted page of 100 documents. Seeding the completed document FIRST
    // and 100 more recently created, never-completed documents afterward reproduces exactly the
    // shape a page-limited read would drop it from — this endpoint must still find it because it
    // is not paginated at all.
    it('finds a completed document past the first 100, sorted newest-first', async () => {
      const scopeTenant = await registerTestUser(app, {
        email: 'dashboard-beyond-100-e2e@example.com',
        password: 'correct-horse-battery',
      });
      await seedDocumentWithVersion('oldest-completed-doc', {
        ingestionStatus: 'completed',
        tenantId: scopeTenant.tenantId,
      });

      const laterDocs = Array.from({ length: 100 }, (_, index) => index);
      for (const batch of [laterDocs.slice(0, 50), laterDocs.slice(50)]) {
        await Promise.all(
          batch.map((index) =>
            seedDocumentWithVersion(`newer-pending-doc-${index}`, {
              ingestionStatus: 'pending',
              tenantId: scopeTenant.tenantId,
            }),
          ),
        );
      }

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', scopeTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(response.status).toBe(200);
      expect(body.documentCount).toBe(101);
      expect(body.hasIngestedDocument).toBe(true);
    });

    it('counts only sources whose most recent sync failed', async () => {
      const scopeTenant = await registerTestUser(app, {
        email: 'dashboard-sources-e2e@example.com',
        password: 'correct-horse-battery',
      });
      await sourceModel.create({
        name: 'Failed source',
        kind: 'local-folder',
        path: '/data/failed',
        tenantId: scopeTenant.tenantId,
        lastSyncStatus: 'failed',
      });
      await sourceModel.create({
        name: 'Healthy source',
        kind: 'local-folder',
        path: '/data/healthy',
        tenantId: scopeTenant.tenantId,
        lastSyncStatus: 'ok',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', scopeTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(body.sourceCount).toBe(2);
      expect(body.syncFailedCount).toBe(1);
    });

    it("counts the tenant's total answers", async () => {
      const scopeTenant = await registerTestUser(app, {
        email: 'dashboard-answers-e2e@example.com',
        password: 'correct-horse-battery',
      });
      await answerModel.create({
        questionText: 'What is the cap rate?',
        tenantId: scopeTenant.tenantId,
      });
      await answerModel.create({
        questionText: 'What is the noi?',
        tenantId: scopeTenant.tenantId,
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', scopeTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(body.answerCount).toBe(2);
    });

    it("excludes another tenant's rows from every count", async () => {
      const ownTenant = await registerTestUser(app, {
        email: 'dashboard-cross-tenant-own-e2e@example.com',
        password: 'correct-horse-battery',
      });
      const otherTenant = await registerTestUser(app, {
        email: 'dashboard-cross-tenant-other-e2e@example.com',
        password: 'correct-horse-battery',
      });
      await seedDocumentWithVersion('other-tenant-failed-doc', {
        ingestionStatus: 'failed',
        tenantId: otherTenant.tenantId,
      });
      await sourceModel.create({
        name: 'Other tenant source',
        kind: 'local-folder',
        path: '/data/other',
        tenantId: otherTenant.tenantId,
        lastSyncStatus: 'failed',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/dashboard/summary')
        .set('Cookie', ownTenant.cookie);
      const body = response.body as DashboardSummaryBody;

      expect(response.status).toBe(200);
      expect(body).toEqual({
        pendingApprovalCount: 0,
        openConflictCount: 0,
        documentCount: 0,
        sourceCount: 0,
        ingestionFailedCount: 0,
        syncFailedCount: 0,
        needsOcrCount: 0,
        factsFailedCount: 0,
        answerCount: 0,
        hasIngestedDocument: false,
      });
    });
  });
});
