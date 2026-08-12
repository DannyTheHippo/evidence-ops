import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { User, UserDocument } from '../../src/database/schemas/administration/user/user.schema';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../src/database/schemas/audit/audit-event/audit-event.schema';
import {
  Conflict,
  ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../src/providers/storage/document-store.interface';
import { FakeWorkflowEngine } from '../../src/providers/workflow-engine/fake-workflow.engine';
import { WORKFLOW_ENGINE } from '../../src/providers/workflow-engine/workflow-engine.interface';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { readSseEvent } from '../utils/read-sse-event';

const FIXTURES = path.join(__dirname, '../../fixtures/data-room');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface DocumentVersionBody {
  id: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  ingestionStatus: string;
  createdAt: string;
}

interface DocumentBody {
  id: string;
  title: string;
  sourceKind: string;
  mimeType: string;
  currentVersion: DocumentVersionBody;
  createdAt: string;
}

describe('Documents (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let adminToken: string;
  let comps: Buffer;
  let memo: Buffer;
  let fakeWorkflowEngine: FakeWorkflowEngine;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let evidenceChunkModel: Model<EvidenceChunkDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let conflictModel: Model<ConflictDocument>;
  let auditEventModel: Model<AuditEventDocument>;
  let documentStore: DocumentStore;

  beforeAll(async () => {
    app = await createTestApp();
    fakeWorkflowEngine = app.get<FakeWorkflowEngine>(WORKFLOW_ENGINE);

    const credentials = { email: 'documents-e2e@example.com', password: 'correct-horse-battery' };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentials);
    const login = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    token = (login.body as { accessToken: string }).accessToken;

    // DELETE /documents/:id is admin-gated; a freshly-registered user defaults to `member`. Flip
    // the row directly, then re-login — the role travels in the JWT, so flipping the row without
    // re-issuing the token would leave the existing `token` unchanged. Mirrors
    // `approvals.e2e-spec.ts`'s identical admin-flip block for its own admin-gated route.
    const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    const adminCredentials = {
      email: 'documents-admin-e2e@example.com',
      password: 'correct-horse-battery',
    };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(adminCredentials);
    await userModel.updateOne({ email: adminCredentials.email }, { role: UserRole.Admin });
    const adminLogin = await request(getTestServer(app))
      .post('/api/v1/auth/login')
      .send(adminCredentials);
    adminToken = (adminLogin.body as { accessToken: string }).accessToken;

    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
    evidenceChunkModel = app.get<Model<EvidenceChunkDocument>>(getModelToken(EvidenceChunk.name));
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    documentStore = app.get<DocumentStore>(DOCUMENT_STORE);

    comps = await readFile(path.join(FIXTURES, 'comps.xlsx'));
    memo = await readFile(path.join(FIXTURES, 'valuation-memo.pdf'));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const upload = (body: Buffer, filename: string, mime: string, fields: Record<string, string>) => {
    const req = request(getTestServer(app))
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`);

    for (const [key, value] of Object.entries(fields)) {
      void req.field(key, value);
    }

    return req.attach('file', body, { filename, contentType: mime });
  };

  // Direct model writes, following the seeding pattern in `qa.e2e-spec.ts`'s conflicts block —
  // no route creates a chunk row directly, ingestion does, and the workflow that runs it is
  // faked in this test app. Shared across describe blocks: the delete-cascade suite needs a chunk
  // whose `documentId` genuinely matches the uploaded document, not the random one the chunks-list
  // suite defaults to (that suite only ever queries by `documentVersionId`).
  const seedChunk = (
    documentVersionId: string,
    page: number,
    overrides: Record<string, unknown> = {},
  ) =>
    evidenceChunkModel.create({
      _id: `chunk-${documentVersionId}-${page}-${new Types.ObjectId().toString()}`,
      documentId: new Types.ObjectId(),
      documentVersionId: new Types.ObjectId(documentVersionId),
      text: `chunk text for page ${page}`,
      tokenCount: 100 + page,
      embedding: [0.1, 0.2, 0.3],
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page },
      ingestionAttemptToken: new Types.ObjectId(),
      ...overrides,
    });

  it('rejects an unauthenticated upload — the routes are not public', async () => {
    const response = await request(getTestServer(app))
      .post('/api/v1/documents')
      .attach('file', comps, { filename: 'comps.xlsx', contentType: XLSX_MIME });

    expect(response.status).toBe(401);
  });

  it('stores an upload and pins the version to the sha256 of the bytes', async () => {
    const response = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Comparables' });
    const body = response.body as DocumentBody;

    expect(response.status).toBe(201);
    expect(body.title).toBe('Comparables');
    expect(body.sourceKind).toBe('xlsx');
    expect(body.currentVersion.versionNumber).toBe(1);
    expect(body.currentVersion.sha256).toBe(createHash('sha256').update(comps).digest('hex'));
    expect(body.currentVersion.sizeBytes).toBe(comps.byteLength);
    // FakeWorkflowEngine records the start but never executes it, so the version's own
    // `ingestionStatus` field stays at its schema default here.
    expect(body.currentVersion.ingestionStatus).toBe('pending');

    // Asserting the exact key set is the only gate that catches a response-DTO field missing
    // @Expose() — such a field is silently dropped from the payload with no error anywhere.
    expect(Object.keys(body).sort()).toEqual(
      ['id', 'title', 'sourceKind', 'mimeType', 'currentVersion', 'createdAt'].sort(),
    );
    expect(Object.keys(body.currentVersion).sort()).toEqual(
      ['id', 'versionNumber', 'sha256', 'sizeBytes', 'ingestionStatus', 'createdAt'].sort(),
    );
    expect(JSON.stringify(body)).not.toMatch(/storageKey/i);

    // Proves work item 1 end to end within what this sandbox-safe e2e can observe: the upload
    // request actually reaches `WorkflowEngine.start` with the new version's id. The chain the
    // workflow itself runs (chunk+embed → extract facts → scan conflicts) is proven separately by
    // the gated integration spec — FakeWorkflowEngine never executes what it records.
    const started = fakeWorkflowEngine.started.find(
      (call) =>
        call.workflowType === 'ingestDocumentVersion' &&
        (call.input as { documentVersionId: string }).documentVersionId === body.currentVersion.id,
    );
    expect(started).toBeDefined();
  });

  it('does not create a second version when the same bytes are re-uploaded', async () => {
    const first = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Idempotent' });
    const documentId = (first.body as DocumentBody).id;

    const startedBeforeReupload = fakeWorkflowEngine.started.length;
    const again = await upload(comps, 'comps.xlsx', XLSX_MIME, { documentId });
    const body = again.body as DocumentBody;

    expect(body.currentVersion.versionNumber).toBe(1);
    expect(body.currentVersion.id).toBe((first.body as DocumentBody).currentVersion.id);
    // Content-addressed dedupe: no new version was created, so no second ingestion workflow starts.
    expect(fakeWorkflowEngine.started).toHaveLength(startedBeforeReupload);

    const detail = await request(getTestServer(app))
      .get(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`);

    expect((detail.body as { versions: DocumentVersionBody[] }).versions).toHaveLength(1);
  });

  it('creates version 2 when different bytes are uploaded to the same document', async () => {
    const first = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Versioned' });
    const documentId = (first.body as DocumentBody).id;

    const second = await upload(memo, 'valuation-memo.pdf', 'application/pdf', { documentId });
    const body = second.body as DocumentBody;

    expect(body.currentVersion.versionNumber).toBe(2);
    expect(body.currentVersion.sha256).toBe(createHash('sha256').update(memo).digest('hex'));

    const detail = await request(getTestServer(app))
      .get(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`);
    const versions = (detail.body as { versions: DocumentVersionBody[] }).versions;

    expect(versions).toHaveLength(2);
    // Version 1 must still report the original hash: a citation pinned to it stays honest about
    // which bytes it referred to, which is the entire point of content addressing.
    expect(versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
    expect(versions.find((v) => v.versionNumber === 1)?.sha256).toBe(
      createHash('sha256').update(comps).digest('hex'),
    );
  });

  it('refuses a content type outside the allowlist', async () => {
    const response = await upload(Buffer.from('binary junk'), 'photo.png', 'image/png', {
      title: 'Rejected',
    });

    expect(response.status).toBe(415);
  });

  // Windows reports a .csv as this exact MIME — the same string a legacy .xls binary reports —
  // so the resolver must fall through to the extension allowlist rather than trusting either MIME
  // directly. `resolveUploadKind`'s ambiguous-set comment (`documents.constant.ts`) is the design
  // rationale; these three cases are its acceptance test at the HTTP boundary.
  it('accepts application/vnd.ms-excel when the extension resolves it to csv — the Windows-reported .csv case', async () => {
    const response = await upload(
      Buffer.from('name,cap_rate\nNorthgate,5.25'),
      'comps.csv',
      'application/vnd.ms-excel',
      { title: 'Windows CSV' },
    );
    const body = response.body as DocumentBody;

    expect(response.status).toBe(201);
    expect(body.sourceKind).toBe('csv');
    // The canonical MIME, not the browser's raw 'application/vnd.ms-excel' — the parser registry's
    // exact-match lookup (`ParserRegistry.resolve`) depends on the stored contentType already being
    // disambiguated.
    expect(body.mimeType).toBe('text/csv');
  });

  it('rejects application/vnd.ms-excel with a .xls extension — the legacy binary this project does not support, not guessed as a spreadsheet', async () => {
    const response = await upload(
      Buffer.from('xls bytes'),
      'legacy.xls',
      'application/vnd.ms-excel',
      {
        title: 'Legacy XLS',
      },
    );

    expect(response.status).toBe(400);
  });

  it('rejects application/octet-stream with an extension outside the allowlist', async () => {
    const response = await upload(
      Buffer.from('zip bytes'),
      'archive.zip',
      'application/octet-stream',
      { title: 'Unknown Octet Stream' },
    );

    expect(response.status).toBe(400);
  });

  it('lists uploaded documents with a count', async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`);
    const body = response.body as { docs: DocumentBody[]; count: number };

    expect(response.status).toBe(200);
    expect(body.count).toBeGreaterThan(0);
    expect(body.docs.length).toBeGreaterThan(0);
  });

  describe('GET /documents/events', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/documents/events');

      expect(response.status).toBe(401);
    });

    // Bounded read: `readSseEvent` destroys the connection itself the moment the first
    // `documents` frame arrives, BEFORE its promise resolves — this stream never ends on its own
    // (no terminal state, see `DocumentsService.streamList`'s doc comment), so this test never
    // waits for it to.
    it('streams the same list shape the polled GET returns, with SSE headers', async () => {
      const polled = await request(getTestServer(app))
        .get('/api/v1/documents')
        .set('Authorization', `Bearer ${token}`);

      const frame = await readSseEvent(app, '/api/v1/documents/events', 'documents', {
        Authorization: `Bearer ${token}`,
      });

      expect(frame.statusCode).toBe(200);
      expect(frame.headers['content-type']).toContain('text/event-stream');
      expect(frame.headers['cache-control']).toContain('no-cache');
      expect(frame.headers['x-accel-buffering']).toBe('no');
      expect(frame.data).toEqual(polled.body);
    });
  });

  describe('GET /documents/versions/:versionId/content', () => {
    it('rejects an unauthenticated request', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Content Auth' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      const response = await request(getTestServer(app)).get(
        `/api/v1/documents/versions/${versionId}/content`,
      );

      expect(response.status).toBe(401);
    });

    it('round-trips the exact uploaded bytes and reports both headers', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Content Roundtrip' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      const response = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/${versionId}/content`)
        .set('Authorization', `Bearer ${token}`)
        .responseType('blob');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe(XLSX_MIME);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="Content_Roundtrip-v1.xlsx"',
      );
      // The response body must match the uploaded bytes exactly — a truncated or re-encoded
      // buffer would still pass a status/header-only assertion.
      expect(Buffer.compare(response.body as Buffer, comps)).toBe(0);
    });

    it('returns 404, not 403, for a version belonging to another tenant', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Content Tenant' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      // No route lets a self-registered e2e user land in a second tenant, so the cross-tenant
      // row is produced the same way `approvals.e2e-spec.ts` does: flip the persisted row's
      // tenantId directly, then request it with the original (default-tenant) token.
      await documentVersionModel.updateOne({ _id: versionId }, { tenantId: 'other-tenant' });

      const response = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/${versionId}/content`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      // Fail-closed indistinguishability: a genuinely unknown id gets the identical shape.
      const unknown = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/000000000000000000000000/content`)
        .set('Authorization', `Bearer ${token}`);
      expect(unknown.status).toBe(response.status);
    });

    it('returns 404 for a malformed versionId', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/not-an-object-id/content')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });
  });

  describe('GET /documents/versions/:versionId/chunks', () => {
    interface ChunkBody {
      id: string;
      text: string;
      tokenCount: number;
      locator: unknown;
    }

    it('rejects an unauthenticated request', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Chunks Auth' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      const response = await request(getTestServer(app)).get(
        `/api/v1/documents/versions/${versionId}/chunks`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 404 for a malformed versionId', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/not-an-object-id/chunks')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });

    it('returns 404, not 403, for a version belonging to another tenant', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Chunks Tenant' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      await documentVersionModel.updateOne({ _id: versionId }, { tenantId: 'other-tenant' });

      const response = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/${versionId}/chunks`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });

    it("returns chunks in locator order, exposes the exact key set with embedding absent, and excludes another version's chunks", async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Chunks Order' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      const otherUploaded = await upload(memo, 'valuation-memo.pdf', 'application/pdf', {
        title: 'Chunks Other Version',
      });
      const otherVersionId = (otherUploaded.body as DocumentBody).currentVersion.id;

      // Seeded out of order (page 3, then 1, then 2) to prove the response is sorted, not a
      // pass-through of insertion order.
      await seedChunk(versionId, 3);
      await seedChunk(versionId, 1);
      await seedChunk(versionId, 2);
      await seedChunk(otherVersionId, 1);

      const response = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/${versionId}/chunks`)
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as { docs: ChunkBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(3);
      // Excludes the other version's chunk entirely — not just sorted alongside it.
      expect(body.docs).toHaveLength(3);
      expect(body.docs.map((doc) => (doc.locator as { page: number }).page)).toEqual([1, 2, 3]);

      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body.docs[0]).sort()).toEqual(
        ['id', 'text', 'tokenCount', 'locator'].sort(),
      );
      expect(JSON.stringify(body)).not.toMatch(/embedding/i);
    });
  });

  describe('DELETE /documents/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Delete Auth' });
      const documentId = (uploaded.body as DocumentBody).id;

      const response = await request(getTestServer(app)).delete(`/api/v1/documents/${documentId}`);

      expect(response.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin — deleting evidence is the second irreversible boundary in the product', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Delete Forbidden' });
      const documentId = (uploaded.body as DocumentBody).id;

      const response = await request(getTestServer(app))
        .delete(`/api/v1/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`);

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

    it('returns 404 for an unknown document, even for an admin', async () => {
      const response = await request(getTestServer(app))
        .delete('/api/v1/documents/000000000000000000000000')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(404);
    });

    it('cascades the full delete — versions, GridFS bytes, chunks, and facts gone; a referencing conflict resolved as superseded, not deleted; an audit row written', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Delete Cascade' });
      const documentBody = uploaded.body as DocumentBody;
      const documentId = documentBody.id;
      const versionId = documentBody.currentVersion.id;

      const versionRow = await documentVersionModel.findById(versionId);
      const storageKey = versionRow?.storageKey;
      expect(storageKey).toEqual(expect.any(String));

      await seedChunk(versionId, 1, { documentId: new Types.ObjectId(documentId) });

      // Two disagreeing facts form the conflict `MIN_CONFLICTING_FACTS` requires; only one of
      // them belongs to the document being deleted — the conflict must still resolve as
      // superseded even though its other side survives untouched.
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      const deletedFact = await extractedFactModel.create({
        factKey,
        value: { amount: 5.25, unit: 'percent' },
        rawText: 'cap rate of 5.25%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-xlsx',
        documentVersionId: new Types.ObjectId(versionId),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      });
      const survivingFact = await extractedFactModel.create({
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        rawText: 'cap rate of 6.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-prose',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      });
      const conflict = await conflictModel.create({
        factKey,
        factIds: [deletedFact._id, survivingFact._id],
        magnitude: 0.0085,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/documents/${documentId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(204);

      const detail = await request(getTestServer(app))
        .get(`/api/v1/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(detail.status).toBe(404);

      const remainingVersions = await documentVersionModel.find({
        documentId: new Types.ObjectId(documentId),
      });
      expect(remainingVersions).toHaveLength(0);

      const remainingChunks = await evidenceChunkModel.find({
        documentId: new Types.ObjectId(documentId),
      });
      expect(remainingChunks).toHaveLength(0);

      const remainingFacts = await extractedFactModel.find({
        documentVersionId: new Types.ObjectId(versionId),
      });
      expect(remainingFacts).toHaveLength(0);

      const storedBytes = await documentStore.get(storageKey as string);
      expect(storedBytes).toBeNull();

      const resolvedConflict = await conflictModel.findById(conflict._id);
      expect(resolvedConflict?.status).toBe('resolved');
      expect(resolvedConflict?.resolution?.outcome).toBe('superseded');
      // The pull removed the deleted document's own fact — only the survivor's id remains.
      expect(resolvedConflict?.factIds.map((id) => id.toString())).toEqual([
        survivingFact._id.toString(),
      ]);

      // The conflict's surviving fact — untouched, on a document that was never deleted — proves
      // the cascade only reached the deleted document's own rows.
      const survives = await extractedFactModel.findById(survivingFact._id);
      expect(survives).not.toBeNull();

      const events = await auditEventModel.find({ action: 'documents.deleted' });
      expect(events.length).toBeGreaterThan(0);

      // The bug this cascade fixes lived here: `ConflictsService.list()` filters only by
      // `{ tenantId }` — no status filter — and `toConflictDto` throws a 500 whenever any
      // `factIds` entry no longer resolves to an `ExtractedFact`. A test that only checks
      // `conflictModel.findById` never exercises that path; this call to the live endpoint does.
      const conflictsList = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Authorization', `Bearer ${token}`);
      expect(conflictsList.status).toBe(200);
      const listedConflict = (
        conflictsList.body as { docs: Array<{ id: string; status: string; factIds: string[] }> }
      ).docs.find((doc) => doc.id === conflict._id.toString());
      expect(listedConflict?.status).toBe('resolved');
      expect(listedConflict?.factIds).toEqual([survivingFact._id.toString()]);
    });

    it("keeps a 3-fact conflict 'open' with the two surviving factIds when only one of its facts' documents is deleted — the old behaviour resolved the whole conflict on one deletion, silently dropping a still-live disagreement between the two survivors", async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, {
        title: 'Delete Cascade — 3-Fact Conflict',
      });
      const documentBody = uploaded.body as DocumentBody;
      const documentId = documentBody.id;
      const versionId = documentBody.currentVersion.id;

      // Three documents disagreeing about one cap rate: ONE conflict with THREE `factIds` —
      // `Conflict.factIds` is unbounded, and grouping is by `(entity, metric, period)`, not by
      // document pair. Only `deletedFact` belongs to the document this test deletes.
      const factKey = {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: '2025-06',
      };
      const deletedFact = await extractedFactModel.create({
        factKey,
        value: { amount: 5.25, unit: 'percent' },
        rawText: 'cap rate of 5.25%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-xlsx-3fact',
        documentVersionId: new Types.ObjectId(versionId),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F3' },
      });
      const survivingFactA = await extractedFactModel.create({
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        rawText: 'cap rate of 6.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-prose-a',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      });
      const survivingFactB = await extractedFactModel.create({
        factKey,
        value: { amount: 5.8, unit: 'percent' },
        rawText: 'cap rate of 5.80%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-prose-b',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 4 },
      });
      const conflict = await conflictModel.create({
        factKey,
        factIds: [deletedFact._id, survivingFactA._id, survivingFactB._id],
        magnitude: 0.011,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/documents/${documentId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(204);

      const conflictAfterCascade = await conflictModel.findById(conflict._id);
      expect(conflictAfterCascade?.status).toBe('open');
      expect(conflictAfterCascade?.resolution).toBeUndefined();
      expect(conflictAfterCascade?.factIds.map((id) => id.toString()).sort()).toEqual(
        [survivingFactA._id.toString(), survivingFactB._id.toString()].sort(),
      );

      // Same trap as the 2-fact case above: only the live `GET /conflicts` endpoint exercises
      // `toConflictDto`'s `values.length < factIds.length` throw and `list()`'s missing status
      // filter — a still-open conflict with two facts must render, not 500.
      const conflictsList = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Authorization', `Bearer ${token}`);
      expect(conflictsList.status).toBe(200);
      const listedConflict = (
        conflictsList.body as {
          docs: Array<{ id: string; status: string; factIds: string[]; values: unknown[] }>;
        }
      ).docs.find((doc) => doc.id === conflict._id.toString());
      expect(listedConflict?.status).toBe('open');
      expect(listedConflict?.factIds?.sort()).toEqual(
        [survivingFactA._id.toString(), survivingFactB._id.toString()].sort(),
      );
      expect(listedConflict?.values).toHaveLength(2);
    });
  });
});
