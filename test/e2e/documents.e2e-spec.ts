import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../src/database/schemas/audit/audit-event/audit-event.schema';
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
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { readSseEvent } from '../utils/read-sse-event';
import { registerTestUser } from '../utils/register-test-user';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';

const FIXTURES = path.join(__dirname, '../../fixtures/data-room');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Every fixture in this file extracts against the 'cre' v1 pack — the only ontology this code
// has ever had (`metric-ontology.ts`).
const PACK_STAMP = { packId: 'cre', packVersion: 1 } as const;

interface DocumentVersionBody {
  id: string;
  versionNumber: number;
  sha256: string;
  sizeBytes: number;
  ingestionStatus: string;
  reducedFidelityReasons: string[];
  createdAt: string;
}

interface DocumentBody {
  id: string;
  title: string;
  sourceKind: string;
  mimeType: string;
  sourceClass: string;
  currentVersion: DocumentVersionBody;
  createdAt: string;
}

describe('Documents (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let adminCookie: string;
  let tenantId: string;
  let comps: Buffer;
  let memo: Buffer;
  let fakeWorkflowEngine: FakeWorkflowEngine;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let evidenceChunkModel: Model<EvidenceChunkDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let conflictModel: Model<ConflictDocument>;
  let auditEventModel: Model<AuditEventDocument>;
  let documentStore: DocumentStore;

  beforeAll(async () => {
    app = await createTestApp();
    fakeWorkflowEngine = app.get<FakeWorkflowEngine>(WORKFLOW_ENGINE);

    // Registering provisions a brand-new tenant with the registrant as its admin. Co-tenanting the
    // member into that same tenant lets both callers see the same seeded rows, so only the role
    // (admin vs. member) is the variable under test.
    const admin = await registerTestUser(app, {
      email: 'documents-admin-e2e@example.com',
      password: 'correct-horse-battery',
    });
    adminCookie = admin.cookie;
    tenantId = admin.tenantId;

    const member = await registerTestUser(
      app,
      { email: 'documents-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    cookie = member.cookie;

    documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
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
    const req = request(getTestServer(app)).post('/api/v1/documents').set('Cookie', cookie);

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
      tenantId,
      text: `chunk text for page ${page}`,
      tokenCount: 100 + page,
      embedding: [0.1, 0.2, 0.3],
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page },
      ingestionAttemptToken: new Types.ObjectId(),
      ...overrides,
    });

  // Direct model writes for pagination fixtures, following the `seedChunk` pattern above — bulk
  // seeding through the multipart upload route would be needlessly slow for a test that only
  // needs many rows to exist, not real ingested content.
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

  it('rejects an unauthenticated upload — the routes are not public', async () => {
    const response = await request(getTestServer(app))
      .post('/api/v1/documents')
      .attach('file', comps, { filename: 'comps.xlsx', contentType: XLSX_MIME });

    expect(response.status).toBe(401);
  });

  it('titles a new document from the uploaded filename when title is omitted', async () => {
    const response = await upload(comps, 'comps.xlsx', XLSX_MIME, {});
    const body = response.body as DocumentBody;

    expect(response.status).toBe(201);
    expect(body.title).toBe('comps.xlsx');
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
      [
        'id',
        'title',
        'sourceKind',
        'mimeType',
        'sourceClass',
        'currentVersion',
        'createdAt',
      ].sort(),
    );
    // No sourceClass was supplied on this upload — the field still round-trips, at the schema's
    // own default, not omitted from the payload.
    expect(body.sourceClass).toBe('unclassified');
    expect(Object.keys(body.currentVersion).sort()).toEqual(
      [
        'id',
        'versionNumber',
        'sha256',
        'sizeBytes',
        'ingestionStatus',
        'reducedFidelityReasons',
        'createdAt',
      ].sort(),
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

  it('exposes ingestionFailureReason only once a version is actually marked failed, with the exact key set at each state', async () => {
    const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, {
      title: 'Ingestion Failure Reason',
    });
    const documentId = (uploaded.body as DocumentBody).id;
    const versionId = (uploaded.body as DocumentBody).currentVersion.id;

    /**
     * Undefined class-transformer fields are dropped before serialization (`toResponseDto`'s
     * `excludeExtraneousValues`), so a version that never failed must not carry the key at all —
     * this is what distinguishes "never failed" from "failed with an empty reason" at the wire
     * level.
     */
    expect(Object.keys((uploaded.body as DocumentBody).currentVersion).sort()).toEqual(
      [
        'id',
        'versionNumber',
        'sha256',
        'sizeBytes',
        'ingestionStatus',
        'reducedFidelityReasons',
        'createdAt',
      ].sort(),
    );

    /**
     * No route sets `ingestionStatus: 'failed'` within what this sandbox-safe e2e can drive —
     * `FakeWorkflowEngine` never executes the workflow that would call `IngestionService` — so the
     * failed state is seeded directly on the model, mirroring the cross-tenant tests elsewhere in
     * this file.
     */
    await documentVersionModel.updateOne(
      { _id: versionId },
      {
        ingestionStatus: 'failed',
        ingestionFailureReason:
          'Document has 1 page(s) but no extractable text on any of them ' +
          '(likely a scanned image with no embedded text layer); OCR is out of scope for this parser',
      },
    );

    const detail = await request(getTestServer(app))
      .get(`/api/v1/documents/${documentId}`)
      .set('Cookie', cookie);
    const version = (detail.body as DocumentBody).currentVersion;

    expect(version.ingestionStatus).toBe('failed');
    expect(
      (version as DocumentVersionBody & { ingestionFailureReason?: string }).ingestionFailureReason,
    ).toBe(
      'Document has 1 page(s) but no extractable text on any of them ' +
        '(likely a scanned image with no embedded text layer); OCR is out of scope for this parser',
    );
    /**
     * Asserting the exact key set is the only gate that catches a response-DTO field missing
     * @Expose() — such a field is silently dropped from the payload with no error anywhere.
     */
    expect(Object.keys(version).sort()).toEqual(
      [
        'id',
        'versionNumber',
        'sha256',
        'sizeBytes',
        'ingestionStatus',
        'ingestionFailureReason',
        'reducedFidelityReasons',
        'createdAt',
      ].sort(),
    );

    // `facts-failed` is the partial-success state: chunks committed and searchable, facts never
    // extracted (`IngestionService.recordFactExtractionFailure`). It reaches the API through the
    // same exposed field, so it is asserted through the same route rather than trusted to the
    // union type, which no runtime gate checks.
    await documentVersionModel.updateOne(
      { _id: versionId },
      {
        ingestionStatus: 'facts-failed',
        ingestionFailureReason: 'daily spend ceiling reached',
      },
    );

    const factsFailed = await request(getTestServer(app))
      .get(`/api/v1/documents/${documentId}`)
      .set('Cookie', cookie);
    const factsFailedVersion = (factsFailed.body as DocumentBody).currentVersion;

    expect(factsFailedVersion.ingestionStatus).toBe('facts-failed');
    expect(
      (factsFailedVersion as DocumentVersionBody & { ingestionFailureReason?: string })
        .ingestionFailureReason,
    ).toBe('daily spend ceiling reached');
  });

  it('exposes reducedFidelityReasons — empty by default, populated once ingestion records a fidelity loss', async () => {
    const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, {
      title: 'Reduced Fidelity Reasons',
    });
    const documentId = (uploaded.body as DocumentBody).id;
    const versionId = (uploaded.body as DocumentBody).currentVersion.id;

    // Unlike `ingestionFailureReason`, this field always carries a key (an empty array, not an
    // omitted one) — `@Expose()` only drops a field whose value is `undefined`, and the schema
    // default is `[]`, never `undefined`.
    expect((uploaded.body as DocumentBody).currentVersion.reducedFidelityReasons).toEqual([]);

    await documentVersionModel.updateOne(
      { _id: versionId },
      {
        reducedFidelityReasons: [
          'Document has 3 page(s) but no extractable text on any of them; falling back to OCR-only extraction for those pages',
        ],
      },
    );

    const detail = await request(getTestServer(app))
      .get(`/api/v1/documents/${documentId}`)
      .set('Cookie', cookie);
    const version = (detail.body as DocumentBody).currentVersion;

    expect(version.reducedFidelityReasons).toEqual([
      'Document has 3 page(s) but no extractable text on any of them; falling back to OCR-only extraction for those pages',
    ]);
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
      .set('Cookie', cookie);

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
      .set('Cookie', cookie);
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

  describe('POST /documents sourceClass', () => {
    it('round-trips a valid sourceClass on a newly created document', async () => {
      const response = await upload(comps, 'comps.xlsx', XLSX_MIME, {
        title: 'Classified Upload',
        sourceClass: 'crm-export',
      });
      const body = response.body as DocumentBody;

      expect(response.status).toBe(201);
      expect(body.sourceClass).toBe('crm-export');
    });

    // The guard this closes: `resolveConflictPolicy` refuses to rank a fact whose document is
    // 'unclassified' because that means no authority information was recorded, not the lowest
    // rank — accepting the word here as an explicit value would be a second way to say nothing,
    // the same reasoning `UpsertMetricPolicyRequestDto.authorityOrder` already applies.
    it('refuses an explicit sourceClass of unclassified', async () => {
      const response = await upload(comps, 'comps.xlsx', XLSX_MIME, {
        title: 'Explicit Unclassified',
        sourceClass: 'unclassified',
      });

      expect(response.status).toBe(400);
    });

    it('refuses a sourceClass outside the declared enum', async () => {
      const response = await upload(comps, 'comps.xlsx', XLSX_MIME, {
        title: 'Bogus Class',
        sourceClass: 'bogus-class',
      });

      expect(response.status).toBe(400);
    });

    // Absent means unclassified, and unclassified means no proposal for this document's facts —
    // this is the ungated default the field's addition must never change.
    it('still succeeds with no sourceClass, defaulting to unclassified', async () => {
      const response = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'No Class Given' });
      const body = response.body as DocumentBody;

      expect(response.status).toBe(201);
      expect(body.sourceClass).toBe('unclassified');
    });

    // End to end, not just at the DTO boundary: an upload that leaves sourceClass unset must
    // still flow through to `resolveConflictPolicy` refusing a proposal for it —
    // `net_operating_income` carries a real `authorityOrder` default (`metric-ontology.ts`), so a
    // classified counterpart fact in the same conflict WOULD win a proposal if this document's
    // default were anything other than 'unclassified'.
    it("carries the uploaded document's unclassified default through to a conflict, refusing a proposal for it", async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, {
        title: 'Unclassified NOI Source',
      });
      const uploadedVersionId = (uploaded.body as DocumentBody).currentVersion.id;

      const pmDocument = await documentModel.create({
        tenantId,
        title: 'Rent Roll.xlsx',
        sourceKind: 'xlsx',
        mimeType: XLSX_MIME,
        sourceClass: 'pm-export',
      });
      const pmVersion = await documentVersionModel.create({
        tenantId,
        documentId: pmDocument._id,
        versionNumber: 1,
        sha256: 'e'.repeat(64),
        sizeBytes: 100,
        storageKey: `pm-rent-roll-${pmDocument._id.toString()}`,
      });

      // A `Document` whose `currentVersionId` is unset is a state no upload path produces, and
      // `DocumentsService.list` refuses it with a 500 rather than serving a document it cannot
      // describe. Linking the version back keeps this fixture to states the API can actually reach.
      pmDocument.currentVersionId = pmVersion._id;
      await pmDocument.save();

      const factKey = {
        entity: 'Unclassified Default Business Park',
        metric: 'net_operating_income',
        period: '2025-05',
      };
      const unclassifiedFact = await extractedFactModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        value: { amount: 480000, unit: 'usd' },
        rawText: 'NOI of $480,000',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-unclassified',
        documentVersionId: new Types.ObjectId(uploadedVersionId),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'B2' },
      });
      const pmFact = await extractedFactModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        value: { amount: 500000, unit: 'usd' },
        rawText: 'NOI of $500,000',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-pm',
        documentVersionId: pmVersion._id,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Rent Roll', cell: 'B2' },
      });
      const conflict = await conflictModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        factIds: [unclassifiedFact._id, pmFact._id],
        magnitude: 20000,
        magnitudeUnit: 'usd',
        ...PACK_STAMP,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookie);
      const body = response.body as {
        docs: Array<{
          id: string;
          ruleFired: string;
          explanation: string;
          proposedWinnerFactId?: string;
        }>;
      };

      expect(response.status).toBe(200);
      const listed = body.docs.find((doc) => doc.id === conflict._id.toString());
      expect(listed).toBeDefined();
      expect(listed?.ruleFired).toBe('none');
      expect(listed?.explanation).toContain('unclassified');
      expect(listed?.proposedWinnerFactId).toBeUndefined();
    });
  });

  it('lists uploaded documents with a count', async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/documents')
      .set('Cookie', cookie);
    const body = response.body as { docs: DocumentBody[]; count: number };

    expect(response.status).toBe(200);
    expect(body.count).toBeGreaterThan(0);
    expect(body.docs.length).toBeGreaterThan(0);
  });

  describe('GET /documents sort', () => {
    it('returns 400 for a sort field outside the declared allowlist', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ sort: 'mimeType' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a sortDir outside asc/desc', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ sort: 'title', sortDir: 'ascending' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('sorts by createdAt descending by default, and lets the caller switch to title ascending', async () => {
      const sortTenant = await registerTestUser(app, {
        email: 'documents-sort-e2e@example.com',
        password: 'correct-horse-battery',
      });

      // `createdAt` stamped explicitly, out of title order — sequential in-memory creates can
      // land in the same millisecond, which would make the default-sort assertion below flaky.
      const bDoc = await seedDocumentWithVersion('Sort E2E B', { tenantId: sortTenant.tenantId });
      const cDoc = await seedDocumentWithVersion('Sort E2E C', { tenantId: sortTenant.tenantId });
      const aDoc = await seedDocumentWithVersion('Sort E2E A', { tenantId: sortTenant.tenantId });
      await documentModel.updateOne(
        { _id: bDoc._id },
        { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      );
      await documentModel.updateOne(
        { _id: cDoc._id },
        { createdAt: new Date('2026-01-02T00:00:00.000Z') },
      );
      await documentModel.updateOne(
        { _id: aDoc._id },
        { createdAt: new Date('2026-01-03T00:00:00.000Z') },
      );

      const defaultResponse = await request(getTestServer(app))
        .get('/api/v1/documents')
        .set('Cookie', sortTenant.cookie);
      const defaultBody = defaultResponse.body as { docs: DocumentBody[]; count: number };

      expect(defaultResponse.status).toBe(200);
      // A carries the latest stamped createdAt, B the earliest — newest-first (the default)
      // orders them A, C, B.
      expect(defaultBody.docs.map((doc) => doc.title)).toEqual([
        'Sort E2E A',
        'Sort E2E C',
        'Sort E2E B',
      ]);

      const titleAscResponse = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ sort: 'title', sortDir: 'asc' })
        .set('Cookie', sortTenant.cookie);
      const titleAscBody = titleAscResponse.body as { docs: DocumentBody[]; count: number };

      expect(titleAscResponse.status).toBe(200);
      expect(titleAscBody.docs.map((doc) => doc.title)).toEqual([
        'Sort E2E A',
        'Sort E2E B',
        'Sort E2E C',
      ]);
    });
  });

  describe('GET /documents ingestionStatus filter', () => {
    // The filter is a direct DB predicate on the CURRENT version's ingestionStatus, not a slice
    // of a fixed-size "newest N" page — seeding well over 100 newer documents proves a failure
    // does not fall out of view the way it does on Home's client-side newest-100 window.
    it('returns a failed current version regardless of how many newer documents exist, and excludes one whose failed version was superseded', async () => {
      const failedDoc = await seedDocumentWithVersion(
        `Failed Fixture ${new Types.ObjectId().toString()}`,
        { ingestionStatus: 'failed' },
      );

      const supersededDoc = await seedDocumentWithVersion(
        `Superseded Fixture ${new Types.ObjectId().toString()}`,
        { ingestionStatus: 'failed' },
      );
      const goodVersion = await documentVersionModel.create({
        documentId: supersededDoc._id,
        versionNumber: 2,
        sha256: createHash('sha256').update('superseded-good-bytes').digest('hex'),
        sizeBytes: 1,
        storageKey: `seed-superseded-good-${supersededDoc._id.toString()}`,
        tenantId,
        ingestionStatus: 'completed',
      });
      supersededDoc.currentVersionId = goodVersion._id;
      await supersededDoc.save();

      for (let i = 0; i < 105; i += 1) {
        await seedDocumentWithVersion(
          `Filter Window Filler ${i}-${new Types.ObjectId().toString()}`,
        );
      }

      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ ingestionStatus: 'failed' })
        .set('Cookie', cookie);
      const body = response.body as { docs: DocumentBody[]; count: number };

      expect(response.status).toBe(200);
      const ids = body.docs.map((doc) => doc.id);
      expect(ids).toContain(failedDoc._id.toString());
      expect(ids).not.toContain(supersededDoc._id.toString());
    });

    it('returns a needs-ocr current version and excludes a completed document', async () => {
      const needsOcrDoc = await seedDocumentWithVersion(
        `Needs OCR Fixture ${new Types.ObjectId().toString()}`,
        { ingestionStatus: 'needs-ocr' },
      );
      const completedDoc = await seedDocumentWithVersion(
        `Completed Fixture ${new Types.ObjectId().toString()}`,
        { ingestionStatus: 'completed' },
      );

      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ ingestionStatus: 'needs-ocr' })
        .set('Cookie', cookie);
      const body = response.body as { docs: DocumentBody[]; count: number };

      expect(response.status).toBe(200);
      const ids = body.docs.map((doc) => doc.id);
      expect(ids).toContain(needsOcrDoc._id.toString());
      expect(ids).not.toContain(completedDoc._id.toString());
    });

    // The corpus-health case the new state exists for: chunks searchable, no facts extracted. A
    // status the filter's `@IsIn` gate did not accept would 400 here rather than list anything.
    it('returns a facts-failed current version and excludes a completed document', async () => {
      const factsFailedDoc = await seedDocumentWithVersion(
        `Facts Failed Fixture ${new Types.ObjectId().toString()}`,
        { ingestionStatus: 'facts-failed' },
      );
      const completedDoc = await seedDocumentWithVersion(
        `Completed Beside Facts Failed ${new Types.ObjectId().toString()}`,
        { ingestionStatus: 'completed' },
      );

      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ ingestionStatus: 'facts-failed' })
        .set('Cookie', cookie);
      const body = response.body as { docs: DocumentBody[]; count: number };

      expect(response.status).toBe(200);
      const ids = body.docs.map((doc) => doc.id);
      expect(ids).toContain(factsFailedDoc._id.toString());
      expect(ids).not.toContain(completedDoc._id.toString());
    });

    it('returns 400 for an ingestionStatus outside the declared enum', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ ingestionStatus: 'bogus' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });
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
        .set('Cookie', cookie);

      const frame = await readSseEvent(app, '/api/v1/documents/events', 'documents', {
        Cookie: cookie,
      });

      expect(frame.statusCode).toBe(200);
      expect(frame.headers['content-type']).toContain('text/event-stream');
      expect(frame.headers['cache-control']).toContain('no-cache');
      expect(frame.headers['x-accel-buffering']).toBe('no');
      expect(frame.data).toEqual(polled.body);
    });

    // The headline regression this cycle exists for: the stream used to hardcode the newest 20
    // documents, so a tenant paging past that window saw the stream and the poll disagree. Seeding
    // 21 fresh documents guarantees a non-empty page 2 regardless of how many other tests in this
    // file already uploaded into the same tenant.
    it('agrees with the polled GET on page 2 for a tenant with more than 20 documents', async () => {
      for (let i = 0; i < 21; i += 1) {
        await seedDocumentWithVersion(`Page 2 Fixture ${i}-${new Types.ObjectId().toString()}`);
      }

      const polled = await request(getTestServer(app))
        .get('/api/v1/documents')
        .query({ skip: 20, limit: 20 })
        .set('Cookie', cookie);

      const polledBody = polled.body as { docs: unknown[]; count: number };

      const frame = await readSseEvent(
        app,
        '/api/v1/documents/events?skip=20&limit=20',
        'documents',
        { Cookie: cookie },
      );
      const body = frame.data as { docs: unknown[]; count: number };

      expect(polledBody.count).toBeGreaterThan(20);
      expect(body.docs.length).toBeGreaterThan(0);
      expect(frame.data).toEqual(polled.body);
    });
  });

  describe('GET /documents/versions/lookup', () => {
    interface VersionLookupBody {
      versionId: string;
      documentId: string;
      documentTitle: string;
      versionNumber: number;
      sourceKind: string;
      withdrawn: boolean;
    }

    it('rejects an unauthenticated request', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Lookup Auth' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/lookup')
        .query({ versionIds: versionId });

      expect(response.status).toBe(401);
    });

    it('resolves a requested version id to its document, exposing the exact key set of all six fields', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Lookup Resolved' });
      const documentBody = uploaded.body as DocumentBody;
      const versionId = documentBody.currentVersion.id;

      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/lookup')
        .query({ versionIds: versionId })
        .set('Cookie', cookie);
      const body = response.body as { docs: VersionLookupBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs).toEqual([
        {
          versionId,
          documentId: documentBody.id,
          documentTitle: 'Lookup Resolved',
          versionNumber: 1,
          sourceKind: 'xlsx',
          withdrawn: false,
        },
      ]);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body.docs[0]).sort()).toEqual(
        [
          'versionId',
          'documentId',
          'documentTitle',
          'versionNumber',
          'sourceKind',
          'withdrawn',
        ].sort(),
      );
    });

    it('resolves both the comma-separated and repeated-param forms of versionIds identically', async () => {
      const first = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Lookup Multi A' });
      const second = await upload(memo, 'valuation-memo.pdf', 'application/pdf', {
        title: 'Lookup Multi B',
      });
      const versionIdA = (first.body as DocumentBody).currentVersion.id;
      const versionIdB = (second.body as DocumentBody).currentVersion.id;

      const commaSeparated = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/lookup?versionIds=${versionIdA},${versionIdB}`)
        .set('Cookie', cookie);

      const repeatedParam = await request(getTestServer(app))
        .get('/api/v1/documents/versions/lookup')
        .query({ versionIds: [versionIdA, versionIdB] })
        .set('Cookie', cookie);

      expect(commaSeparated.status).toBe(200);
      expect(repeatedParam.status).toBe(200);
      const idsFrom = (res: typeof commaSeparated) =>
        (res.body as { docs: VersionLookupBody[] }).docs.map((doc) => doc.versionId).sort();
      expect(idsFrom(commaSeparated)).toEqual([versionIdA, versionIdB].sort());
      expect(idsFrom(repeatedParam)).toEqual([versionIdA, versionIdB].sort());
    });

    it('resolves a soft-withdrawn version with withdrawn: true rather than dropping it', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Lookup Withdrawn' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      await documentVersionModel.updateOne(
        { _id: versionId },
        { withdrawnAt: new Date(), withdrawnReason: 'source-file-absent' },
      );

      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/lookup')
        .query({ versionIds: versionId })
        .set('Cookie', cookie);
      const body = response.body as { docs: VersionLookupBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs[0].withdrawn).toBe(true);
    });

    // The designed contract, not an error path: a stale or cross-tenant id must not poison a
    // whole page of citations, and a cross-tenant id must stay indistinguishable from a
    // nonexistent one — 200 with a shorter `docs` array, never a 404.
    it('silently omits an unknown id and a cross-tenant id — 200 with fewer docs than requested, never a 404', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Lookup Partial' });
      const resolvableVersionId = (uploaded.body as DocumentBody).currentVersion.id;

      const crossTenantUploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, {
        title: 'Lookup Cross Tenant',
      });
      const crossTenantVersionId = (crossTenantUploaded.body as DocumentBody).currentVersion.id;
      await documentVersionModel.updateOne(
        { _id: crossTenantVersionId },
        { tenantId: 'other-tenant' },
      );

      const unknownVersionId = new Types.ObjectId().toString();

      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/lookup')
        .query({ versionIds: [resolvableVersionId, crossTenantVersionId, unknownVersionId] })
        .set('Cookie', cookie);
      const body = response.body as { docs: VersionLookupBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.docs.map((doc) => doc.versionId)).toEqual([resolvableVersionId]);
    });

    it('returns 400 for a malformed version id', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/lookup')
        .query({ versionIds: 'not-an-object-id' })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
    });

    it('returns 400 for more than 100 requested ids', async () => {
      const tooMany = Array.from({ length: 101 }, () => new Types.ObjectId().toString());

      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/lookup')
        .query({ versionIds: tooMany })
        .set('Cookie', cookie);

      expect(response.status).toBe(400);
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
        .set('Cookie', cookie)
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

      // The cross-tenant row is produced the same way `approvals.e2e-spec.ts` does: flip the
      // persisted row's tenantId directly, then request it with the original session cookie.
      await documentVersionModel.updateOne({ _id: versionId }, { tenantId: 'other-tenant' });

      const response = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/${versionId}/content`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
      // Fail-closed indistinguishability: a genuinely unknown id gets the identical shape.
      const unknown = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/000000000000000000000000/content`)
        .set('Cookie', cookie);
      expect(unknown.status).toBe(response.status);
    });

    it('returns 404 for a malformed versionId', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/documents/versions/not-an-object-id/content')
        .set('Cookie', cookie);

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
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('returns 404, not 403, for a version belonging to another tenant', async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, { title: 'Chunks Tenant' });
      const versionId = (uploaded.body as DocumentBody).currentVersion.id;

      await documentVersionModel.updateOne({ _id: versionId }, { tenantId: 'other-tenant' });

      const response = await request(getTestServer(app))
        .get(`/api/v1/documents/versions/${versionId}/chunks`)
        .set('Cookie', cookie);

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
        .set('Cookie', cookie);
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
        .set('Cookie', cookie);

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
        .set('Cookie', adminCookie);

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
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 5.25, unit: 'percent' },
        rawText: 'cap rate of 5.25%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-xlsx',
        documentVersionId: new Types.ObjectId(versionId),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      });
      const survivingFact = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 6.1, unit: 'percent' },
        rawText: 'cap rate of 6.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-prose',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      });
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        factIds: [deletedFact._id, survivingFact._id],
        magnitude: 0.0085,
        magnitudeUnit: 'ratio',
        ...PACK_STAMP,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/documents/${documentId}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(204);

      const detail = await request(getTestServer(app))
        .get(`/api/v1/documents/${documentId}`)
        .set('Cookie', cookie);
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

      // A test that only checks `conflictModel.findById` never exercises `ConflictsService.list`'s
      // own read of `factIds` against the live `ExtractedFact` collection — this call to the live
      // endpoint does, proving the pruned `factIds` renders cleanly rather than only existing in
      // the database.
      const conflictsList = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookie);
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
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 5.25, unit: 'percent' },
        rawText: 'cap rate of 5.25%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-xlsx-3fact',
        documentVersionId: new Types.ObjectId(versionId),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F3' },
      });
      const survivingFactA = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 6.1, unit: 'percent' },
        rawText: 'cap rate of 6.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-prose-a',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      });
      const survivingFactB = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 5.8, unit: 'percent' },
        rawText: 'cap rate of 5.80%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-prose-b',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 4 },
      });
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        factIds: [deletedFact._id, survivingFactA._id, survivingFactB._id],
        magnitude: 0.011,
        magnitudeUnit: 'ratio',
        ...PACK_STAMP,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/documents/${documentId}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(204);

      const conflictAfterCascade = await conflictModel.findById(conflict._id);
      expect(conflictAfterCascade?.status).toBe('open');
      expect(conflictAfterCascade?.resolution).toBeUndefined();
      expect(conflictAfterCascade?.factIds.map((id) => id.toString()).sort()).toEqual(
        [survivingFactA._id.toString(), survivingFactB._id.toString()].sort(),
      );

      // Same trap as the 2-fact case above: only the live `GET /conflicts` endpoint exercises
      // `ConflictsService.list`'s own read of `factIds` against the live `ExtractedFact`
      // collection — a still-open conflict with two surviving facts must render fully, not
      // degrade.
      const conflictsList = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookie);
      expect(conflictsList.status).toBe(200);
      const listedConflict = (
        conflictsList.body as {
          docs: Array<{
            id: string;
            status: string;
            factIds: string[];
            values: unknown[];
            unscorable: boolean;
          }>;
        }
      ).docs.find((doc) => doc.id === conflict._id.toString());
      expect(listedConflict?.status).toBe('open');
      expect(listedConflict?.factIds?.sort()).toEqual(
        [survivingFactA._id.toString(), survivingFactB._id.toString()].sort(),
      );
      expect(listedConflict?.values).toHaveLength(2);
      expect(listedConflict?.unscorable).toBe(false);
    });

    // `DocumentsService.remove`'s conflict pull is not scoped to `status: 'open'` — a `resolved`
    // conflict's `factIds` is kept in sync with the facts the cascade deletes exactly as an
    // `open` one's is, so its recorded outcome is never left pointing at deleted evidence.
    it("prunes a 'resolved' conflict's factIds too when one of its facts is deleted by a later document deletion, leaving its recorded outcome untouched", async () => {
      const uploaded = await upload(comps, 'comps.xlsx', XLSX_MIME, {
        title: 'Delete Cascade — Resolved Conflict',
      });
      const documentBody = uploaded.body as DocumentBody;
      const documentId = documentBody.id;
      const versionId = documentBody.currentVersion.id;

      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-07' };
      const deletedFact = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 5.25, unit: 'percent' },
        rawText: 'cap rate of 5.25%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-xlsx-resolved',
        documentVersionId: new Types.ObjectId(versionId),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F4' },
      });
      const survivingFact = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 6.1, unit: 'percent' },
        rawText: 'cap rate of 6.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-prose-resolved',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
      });
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        factIds: [deletedFact._id, survivingFact._id],
        magnitude: 0.0085,
        magnitudeUnit: 'ratio',
        ...PACK_STAMP,
        status: 'resolved',
        resolution: {
          outcome: 'resolved',
          winningFactId: survivingFact._id,
          resolvedAt: new Date(),
        },
      });

      const response = await request(getTestServer(app))
        .delete(`/api/v1/documents/${documentId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(204);

      const conflictAfterCascade = await conflictModel.findById(conflict._id);
      // Status and the recorded outcome — already decided by a human — stay untouched; only the
      // dangling reference to the deleted fact is pruned.
      expect(conflictAfterCascade?.status).toBe('resolved');
      expect(conflictAfterCascade?.resolution?.outcome).toBe('resolved');
      expect(conflictAfterCascade?.factIds.map((id) => id.toString())).toEqual([
        survivingFact._id.toString(),
      ]);

      const conflictsList = await request(getTestServer(app))
        .get('/api/v1/conflicts?status=resolved')
        .set('Cookie', cookie);
      expect(conflictsList.status).toBe(200);
      const listedConflict = (
        conflictsList.body as { docs: Array<{ id: string; unscorable: boolean }> }
      ).docs.find((doc) => doc.id === conflict._id.toString());
      expect(listedConflict).toBeDefined();
      // Kept in sync at write time, so the read path never has to degrade it.
      expect(listedConflict?.unscorable).toBe(false);
    });

    // A conflict whose `factIds` no longer resolve — from a direct write, a different deletion
    // path, or any other route than `DocumentsService.remove` — must still render, degraded, not
    // drop the whole page with a 500. Facts are deleted directly here, bypassing
    // `DocumentsService.remove` entirely, to reach that state.
    it("degrades a 'resolved' conflict whose facts no longer resolve to unscorable in both the default and status-filtered list views, rather than 500 the page", async () => {
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-08' };
      const factLow = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 5.25, unit: 'percent' },
        rawText: 'cap rate of 5.25%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-xlsx-orphaned',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F5' },
      });
      const factHigh = await extractedFactModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        value: { amount: 6.1, unit: 'percent' },
        rawText: 'cap rate of 6.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        ...PACK_STAMP,
        chunkId: 'chunk-prose-orphaned',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
      });
      const conflict = await conflictModel.create({
        factKey,
        groupKeyNormalized: groupKey(factKey),
        tenantId,
        factIds: [factLow._id, factHigh._id],
        magnitude: 0.0085,
        magnitudeUnit: 'ratio',
        ...PACK_STAMP,
        status: 'resolved',
        resolution: { outcome: 'resolved', winningFactId: factLow._id, resolvedAt: new Date() },
      });
      await extractedFactModel.deleteMany({ _id: { $in: [factLow._id, factHigh._id] } });

      const defaultList = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookie);
      expect(defaultList.status).toBe(200);
      const defaultListed = (
        defaultList.body as {
          docs: Array<{
            id: string;
            unscorable: boolean;
            unscorableReason?: string;
            ruleFired?: string;
            explanation?: string;
            proposedWinnerFactId?: string;
          }>;
        }
      ).docs.find((doc) => doc.id === conflict._id.toString());
      expect(defaultListed).toBeDefined();
      expect(defaultListed?.unscorable).toBe(true);
      expect(defaultListed?.unscorableReason).toBe(
        '2 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
      );
      expect(defaultListed?.ruleFired).toBeUndefined();
      expect(defaultListed?.explanation).toBeUndefined();
      expect(defaultListed?.proposedWinnerFactId).toBeUndefined();

      const resolvedList = await request(getTestServer(app))
        .get('/api/v1/conflicts?status=resolved')
        .set('Cookie', cookie);
      expect(resolvedList.status).toBe(200);
      const resolvedListed = (
        resolvedList.body as { docs: Array<{ id: string; unscorable: boolean }> }
      ).docs.find((doc) => doc.id === conflict._id.toString());
      expect(resolvedListed?.unscorable).toBe(true);
    });
  });
});
