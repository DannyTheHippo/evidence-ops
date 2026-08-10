import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { FakeWorkflowEngine } from '../../src/providers/workflow-engine/fake-workflow.engine';
import { WORKFLOW_ENGINE } from '../../src/providers/workflow-engine/workflow-engine.interface';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

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
  let comps: Buffer;
  let memo: Buffer;
  let fakeWorkflowEngine: FakeWorkflowEngine;

  beforeAll(async () => {
    app = await createTestApp();
    fakeWorkflowEngine = app.get<FakeWorkflowEngine>(WORKFLOW_ENGINE);

    const credentials = { email: 'documents-e2e@example.com', password: 'correct-horse-battery' };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentials);
    const login = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    token = (login.body as { accessToken: string }).accessToken;

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
    const response = await upload(Buffer.from('plain text'), 'notes.txt', 'text/plain', {
      title: 'Rejected',
    });

    expect(response.status).toBe(415);
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
});
