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
  Document,
  DocumentDocument,
} from '../../src/database/schemas/evidence/document/document.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type {
  Citation,
  VerificationReport,
} from '../../src/features/evidence/qa/contracts/answer.contract';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { readSseEvent } from '../utils/read-sse-event';
import { registerTestUser } from '../utils/register-test-user';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';

interface AnswerUsageBody {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

interface AnswerBody {
  id: string;
  questionText?: string;
  runStatus: string;
  outcome?: unknown;
  claimCoverage?: number;
  retrievedChunkCount?: number;
  verificationReport?: VerificationReport;
  citations?: unknown[];
  conflictIds?: string[];
  createdAt?: string;
  usage?: AnswerUsageBody;
}

interface ConflictValueBody {
  factId: string;
  value: number;
  unit: string;
  sourceChunkId: string;
  documentVersionId: string;
  locator: unknown;
}

interface ConflictBody {
  id: string;
  factKey: { entity: string; metric: string; period: string };
  factIds: string[];
  values: ConflictValueBody[];
  magnitude: number;
  status: string;
  createdAt: string;
  proposedWinnerFactId?: string;
  ruleFired: string;
  explanation: string;
}

describe('QA and Conflicts (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let tenantId: string;
  let answerModel: Model<AnswerDocument>;
  let auditEventModel: Model<AuditEventDocument>;
  let conflictModel: Model<ConflictDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'qa-e2e@example.com', password: 'correct-horse-battery' };
    ({ cookie, userId, tenantId } = await registerTestUser(app, credentials));

    answerModel = app.get<Model<AnswerDocument>>(getModelToken(Answer.name));
    auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    extractedFactModel = app.get<Model<ExtractedFactDocument>>(getModelToken(ExtractedFact.name));
    documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('POST /questions', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/questions')
        .send({ questionText: 'What is the cap rate?' });

      expect(response.status).toBe(401);
    });

    it('rejects a request with an unknown field', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/questions')
        .set('Cookie', cookie)
        .send({ questionText: 'What is the cap rate?', notAField: 'x' });

      expect(response.status).toBe(400);
    });

    it('starts a queued answer, exposing only id and runStatus, and records an audit event', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/questions')
        .set('Cookie', cookie)
        .send({ questionText: 'What is the cap rate for Northgate Business Park?' });
      const body = response.body as AnswerBody;

      expect(response.status).toBe(201);
      expect(body.runStatus).toBe('queued');
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body).sort()).toEqual(['id', 'runStatus'].sort());

      const stored = await answerModel.findById(body.id);
      expect(stored?.runStatus).toBe('queued');
      expect(stored?.outcome).toBeUndefined();

      const events = await auditEventModel.find({
        action: 'qa.question.started',
        'subject.entityId': new Types.ObjectId(body.id),
      });
      expect(events).toHaveLength(1);
      expect(events[0].actor.toString()).toBe(userId);
      expect(events[0].subject.entityType).toBe('Answer');
    });
  });

  describe('GET /answers/:id', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get(
        `/api/v1/answers/${new Types.ObjectId().toString()}`,
      );

      expect(response.status).toBe(401);
    });

    it('returns 404 for a syntactically invalid id rather than a 500', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/answers/not-a-valid-object-id')
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('returns 404 for a well-formed id with no matching Answer', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${new Types.ObjectId().toString()}`)
        .set('Cookie', cookie);

      expect(response.status).toBe(404);
    });

    it('presents a queued answer with no outcome/claimCoverage keys at all, and records an audit event', async () => {
      const started = await request(getTestServer(app))
        .post('/api/v1/questions')
        .set('Cookie', cookie)
        .send({ questionText: 'What is the vacancy rate?' });
      const answerId = (started.body as AnswerBody).id;

      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${answerId}`)
        .set('Cookie', cookie);
      const body = response.body as AnswerBody;

      expect(response.status).toBe(200);
      expect(body.runStatus).toBe('queued');
      // `outcome` and `claimCoverage` must be entirely absent (not present-but-null/undefined) —
      // a non-completed run must never present an outcome as if it were final.
      expect(Object.keys(body).sort()).toEqual(
        ['id', 'questionText', 'runStatus', 'citations', 'conflictIds', 'createdAt'].sort(),
      );

      const events = await auditEventModel.find({
        action: 'qa.answer.viewed',
        'subject.entityId': new Types.ObjectId(answerId),
      });
      expect(events).toHaveLength(1);
    });

    it('presents the full envelope — outcome, claimCoverage, citations — once runStatus is completed', async () => {
      const citation: Citation = {
        docVersionId: 'version-1',
        sha256: 'a'.repeat(64),
        chunkId: 'chunk-1',
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
        quote: 'at a cap rate of approximately 6.10%',
      };
      const verificationReport: VerificationReport = {
        verifiedClaimCount: 1,
        totalClaimCount: 2,
        droppedClaims: [
          { statement: 'The vacancy rate is 4%.', reason: 'quote did not match the source chunk' },
        ],
      };
      const seeded = await answerModel.create({
        tenantId,
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome: {
          kind: 'answered',
          claims: [{ statement: 'The cap rate is approximately 6.10%.', citations: [citation] }],
        },
        claims: [{ statement: 'The cap rate is approximately 6.10%.', citations: [citation] }],
        claimCoverage: 0.8,
        verificationReport,
        usage: { promptTokens: 1240, completionTokens: 180, costUsd: 0.0042 },
        retrievedChunkIds: ['chunk-1', 'chunk-2', 'chunk-3'],
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${seeded._id.toString()}`)
        .set('Cookie', cookie);
      const body = response.body as AnswerBody;

      expect(response.status).toBe(200);
      expect(body.runStatus).toBe('completed');
      expect(body.claimCoverage).toBe(0.8);
      expect(body.retrievedChunkCount).toBe(3);
      expect(body.outcome).toEqual({
        kind: 'answered',
        claims: [{ statement: 'The cap rate is approximately 6.10%.', citations: [citation] }],
      });
      expect(body.citations).toEqual([citation]);
      expect(Object.keys(body).sort()).toEqual(
        [
          'id',
          'questionText',
          'runStatus',
          'outcome',
          'claimCoverage',
          'retrievedChunkCount',
          'verificationReport',
          'citations',
          'conflictIds',
          'createdAt',
          'usage',
        ].sort(),
      );
      // Nested exact key set — the trap this field is most likely to hit is a missing @Type() on
      // the parent field, which serializes usage as {} rather than dropping it, so the top-level
      // key-set assertion alone would not catch it.
      expect(Object.keys(body.usage ?? {}).sort()).toEqual(
        ['promptTokens', 'completionTokens', 'costUsd'].sort(),
      );
      expect(body.usage).toEqual({ promptTokens: 1240, completionTokens: 180, costUsd: 0.0042 });
      // Same nested-key-set trap as `usage` above, one level deeper: `droppedClaims` needs its own
      // @Type() on top of `verificationReport`'s, or it serializes as `[{}]` rather than dropping.
      expect(Object.keys(body.verificationReport ?? {}).sort()).toEqual(
        ['verifiedClaimCount', 'totalClaimCount', 'droppedClaims'].sort(),
      );
      expect(Object.keys(body.verificationReport?.droppedClaims[0] ?? {}).sort()).toEqual(
        ['statement', 'reason'].sort(),
      );
      expect(body.verificationReport).toEqual(verificationReport);
    });

    // Regression for the "conflicting_evidence unreachable" gap (ADR-0004 bound 9): `reasonCode`
    // is a new field on `outcome` for `insufficient_evidence` — an exact `toEqual` here is the
    // only gate that would catch it silently missing `@Expose()` (it would not: `outcome` passes
    // through as a whole object, not per-field, but the assertion still proves the wire shape).
    it('presents a model-authored reasonCode on an insufficient_evidence outcome once completed', async () => {
      const seeded = await answerModel.create({
        tenantId,
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome: {
          kind: 'insufficient_evidence',
          reason:
            'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
          reasonCode: 'retrieved_evidence_contradicts_itself',
        },
        claims: [],
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${seeded._id.toString()}`)
        .set('Cookie', cookie);
      const body = response.body as AnswerBody;

      expect(response.status).toBe(200);
      expect(body.outcome).toEqual({
        kind: 'insufficient_evidence',
        reason:
          'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
        reasonCode: 'retrieved_evidence_contradicts_itself',
      });
    });
  });

  describe('GET /answers', () => {
    let listCookie: string;
    let listTenantId: string;

    beforeAll(async () => {
      const registered = await registerTestUser(app, {
        email: 'qa-answers-list-e2e@example.com',
        password: 'correct-horse-battery',
      });
      listCookie = registered.cookie;
      listTenantId = registered.tenantId;
    });

    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/answers');

      expect(response.status).toBe(401);
    });

    it('lists only the caller tenant answers, newest first, with the exact docs/count key set', async () => {
      const older = await answerModel.create({
        tenantId: listTenantId,
        questionText: 'Older question',
        runStatus: 'completed',
        outcome: {
          kind: 'insufficient_evidence',
          reason: 'no evidence',
          reasonCode: 'no_relevant_evidence',
        },
        claims: [],
      });
      const newer = await answerModel.create({
        tenantId: listTenantId,
        questionText: 'Newer question',
        runStatus: 'completed',
        outcome: {
          kind: 'insufficient_evidence',
          reason: 'no evidence',
          reasonCode: 'no_relevant_evidence',
        },
        claims: [],
      });
      // Under a different tenant entirely — must never appear in `listToken`'s results.
      await answerModel.create({
        tenantId: 'qa-answers-other-tenant',
        questionText: 'Foreign tenant question',
        runStatus: 'completed',
        outcome: {
          kind: 'insufficient_evidence',
          reason: 'no evidence',
          reasonCode: 'no_relevant_evidence',
        },
        claims: [],
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/answers')
        .set('Cookie', listCookie);
      const body = response.body as { docs: AnswerBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBe(2);
      expect(body.docs.map((doc) => doc.id)).toEqual([newer._id.toString(), older._id.toString()]);
    });

    it('filters by runStatus', async () => {
      await answerModel.create({
        tenantId: listTenantId,
        questionText: 'A still-queued question',
        runStatus: 'queued',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/answers')
        .query({ runStatus: 'queued' })
        .set('Cookie', listCookie);
      const body = response.body as { docs: AnswerBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.count).toBeGreaterThan(0);
      expect(body.docs.every((doc) => doc.runStatus === 'queued')).toBe(true);
    });
  });

  describe('GET /answers/:id/events', () => {
    // Bounded read: `readSseEvent` destroys the connection itself the moment the first `answer`
    // frame arrives, BEFORE its promise resolves — this test never waits for the stream to end
    // naturally (`streamAnswer` only ends once the answer reaches a terminal status, which a
    // `queued` answer never does on its own). The socket is already closed by the time any
    // assertion below runs, so nothing here can leave a connection open for `closeTestApp`'s
    // `afterAll` to hang on.
    it('streams the same shape the polled GET returns, with SSE headers, for a queued answer', async () => {
      const started = await request(getTestServer(app))
        .post('/api/v1/questions')
        .set('Cookie', cookie)
        .send({ questionText: 'What is the cap rate?' });
      const answerId = (started.body as AnswerBody).id;

      const polled = await request(getTestServer(app))
        .get(`/api/v1/answers/${answerId}`)
        .set('Cookie', cookie);

      const frame = await readSseEvent(app, `/api/v1/answers/${answerId}/events`, 'answer', {
        Cookie: cookie,
      });

      expect(frame.statusCode).toBe(200);
      expect(frame.headers['content-type']).toContain('text/event-stream');
      expect(frame.headers['cache-control']).toContain('no-cache');
      expect(frame.headers['x-accel-buffering']).toBe('no');
      expect(frame.data).toEqual(polled.body);
    });
  });

  describe('GET /conflicts', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/conflicts');

      expect(response.status).toBe(401);
    });

    it('lists conflicts with a count, exposing the exact conflict key set and value provenance, and records an audit event', async () => {
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      const factLow = await extractedFactModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        value: { amount: 5.25, unit: 'percent' },
        rawText: 'cap rate of 5.25%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-xlsx',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      });
      const factHigh = await extractedFactModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        value: { amount: 6.1, unit: 'percent' },
        rawText: 'cap rate of 6.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-prose',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      });
      await conflictModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        factIds: [factLow._id, factHigh._id],
        magnitude: 0.0085,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookie);
      const body = response.body as { docs: ConflictBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBeGreaterThan(0);
      expect(body.docs.length).toBeGreaterThan(0);
      // `cap_rate` has no configured `authorityOrder` (`metric-ontology.ts`), so the survivorship
      // policy proposes no winner — `proposedWinnerFactId` is undefined, and class-transformer's
      // JSON serialization drops an undefined `@Expose()`d field entirely, so it is absent from the
      // key set here rather than merely `null`.
      expect(Object.keys(body.docs[0]).sort()).toEqual(
        [
          'id',
          'factKey',
          'factIds',
          'values',
          'magnitude',
          'status',
          'createdAt',
          'ruleFired',
          'explanation',
        ].sort(),
      );
      expect(body.docs[0].ruleFired).toBe('none');
      expect(body.docs[0].values.length).toBeGreaterThan(0);
      expect(Object.keys(body.docs[0].values[0]).sort()).toEqual(
        ['factId', 'value', 'unit', 'sourceChunkId', 'documentVersionId', 'locator'].sort(),
      );

      const events = await auditEventModel.find({ action: 'conflicts.listed' });
      expect(events.length).toBeGreaterThan(0);
    });

    it("lists a proposedWinnerFactId for a metric with an authorityOrder, keyed by each fact document's sourceClass", async () => {
      const factKey = {
        entity: 'Southgate Business Park',
        metric: 'net_operating_income',
        period: '2025-03',
      };

      const pmDocument = await documentModel.create({
        tenantId,
        title: 'Rent Roll.xlsx',
        sourceKind: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sourceClass: 'pm-export',
      });
      const pmVersion = await documentVersionModel.create({
        tenantId,
        documentId: pmDocument._id,
        versionNumber: 1,
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        storageKey: 'pm-rent-roll-v1',
      });
      const spreadsheetDocument = await documentModel.create({
        tenantId,
        title: 'Comps.xlsx',
        sourceKind: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sourceClass: 'spreadsheet',
      });
      const spreadsheetVersion = await documentVersionModel.create({
        tenantId,
        documentId: spreadsheetDocument._id,
        versionNumber: 1,
        sha256: 'b'.repeat(64),
        sizeBytes: 100,
        storageKey: 'comps-v1',
      });
      const factPm = await extractedFactModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        value: { amount: 500000, unit: 'usd' },
        rawText: 'NOI of $500,000',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-pm',
        documentVersionId: pmVersion._id,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Rent Roll', cell: 'B2' },
      });
      const factSpreadsheet = await extractedFactModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        value: { amount: 550000, unit: 'usd' },
        rawText: 'NOI of $550,000',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-comps',
        documentVersionId: spreadsheetVersion._id,
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'C4' },
      });
      await conflictModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        factIds: [factPm._id, factSpreadsheet._id],
        magnitude: 50000,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookie);
      const body = response.body as { docs: ConflictBody[]; count: number };

      expect(response.status).toBe(200);
      // The most recently created conflict sorts first (`createdAt: -1`).
      expect(Object.keys(body.docs[0]).sort()).toEqual(
        [
          'id',
          'factKey',
          'factIds',
          'values',
          'magnitude',
          'status',
          'createdAt',
          'proposedWinnerFactId',
          'ruleFired',
          'explanation',
        ].sort(),
      );
      expect(body.docs[0].ruleFired).toBe('authority');
      expect(body.docs[0].proposedWinnerFactId).toBe(factPm._id.toString());
    });

    it('filters by status, with count reflecting the filtered set rather than the collection total', async () => {
      const openFactKey = {
        entity: 'Eastgate Business Park',
        metric: 'cap_rate',
        period: '2025-04',
      };
      const openFactLow = await extractedFactModel.create({
        tenantId,
        factKey: openFactKey,
        groupKeyNormalized: groupKey(openFactKey),
        value: { amount: 5.1, unit: 'percent' },
        rawText: 'cap rate of 5.10%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-eastgate-low',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F3' },
      });
      const openFactHigh = await extractedFactModel.create({
        tenantId,
        factKey: openFactKey,
        groupKeyNormalized: groupKey(openFactKey),
        value: { amount: 6.2, unit: 'percent' },
        rawText: 'cap rate of 6.20%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-eastgate-high',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
      });
      await conflictModel.create({
        tenantId,
        factKey: openFactKey,
        groupKeyNormalized: groupKey(openFactKey),
        factIds: [openFactLow._id, openFactHigh._id],
        magnitude: 0.011,
        status: 'open',
      });

      const dismissedFactKey = {
        entity: 'Westgate Business Park',
        metric: 'cap_rate',
        period: '2025-04',
      };
      const dismissedFactLow = await extractedFactModel.create({
        tenantId,
        factKey: dismissedFactKey,
        groupKeyNormalized: groupKey(dismissedFactKey),
        value: { amount: 5.0, unit: 'percent' },
        rawText: 'cap rate of 5.00%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-westgate-low',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F4' },
      });
      const dismissedFactHigh = await extractedFactModel.create({
        tenantId,
        factKey: dismissedFactKey,
        groupKeyNormalized: groupKey(dismissedFactKey),
        value: { amount: 6.3, unit: 'percent' },
        rawText: 'cap rate of 6.30%',
        confidence: 0.9,
        extractionMethod: 'llm',
        chunkId: 'chunk-westgate-high',
        documentVersionId: new Types.ObjectId(),
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 4 },
      });
      const dismissed = await conflictModel.create({
        tenantId,
        factKey: dismissedFactKey,
        groupKeyNormalized: groupKey(dismissedFactKey),
        factIds: [dismissedFactLow._id, dismissedFactHigh._id],
        magnitude: 0.013,
        status: 'dismissed',
      });

      const unfiltered = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Cookie', cookie);
      const unfilteredBody = unfiltered.body as { docs: ConflictBody[]; count: number };
      // The unfiltered collection already carries every status seeded across this describe block —
      // proving the dismissed row is actually in the collection, not merely filtered out below.
      expect(unfilteredBody.docs.some((doc) => doc.id === dismissed._id.toString())).toBe(true);

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .query({ status: 'dismissed' })
        .set('Cookie', cookie);
      const body = response.body as { docs: ConflictBody[]; count: number };

      expect(response.status).toBe(200);
      expect(body.docs.every((doc) => doc.status === 'dismissed')).toBe(true);
      expect(body.docs.some((doc) => doc.id === dismissed._id.toString())).toBe(true);
      expect(body.count).toBe(body.docs.length);
      expect(body.count).toBeLessThan(unfilteredBody.count);
    });
  });
});
