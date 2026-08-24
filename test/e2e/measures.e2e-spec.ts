import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { Answer, AnswerDocument } from '../../src/database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { groupKey } from '../../src/features/evidence/conflicts/detect-conflicts';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface MeasuresBody {
  answersCompleted: number;
  answersWithVerifiedCitations: number;
  conflictsSurfaced: number;
  conflictsResolved: number;
  meanEvidenceDocumentsPerAnswer: number | null;
  medianAnswerLatencyMs: number | null;
  p95AnswerLatencyMs: number | null;
}

const MEASURES_KEYS = [
  'answersCompleted',
  'answersWithVerifiedCitations',
  'conflictsSurfaced',
  'conflictsResolved',
  'meanEvidenceDocumentsPerAnswer',
  'medianAnswerLatencyMs',
  'p95AnswerLatencyMs',
].sort();

describe('Measures (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let memberCookie: string;
  let tenantId: string;
  let answerModel: Model<AnswerDocument>;
  let conflictModel: Model<ConflictDocument>;
  let evidenceChunkModel: Model<EvidenceChunkDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const admin = await registerTestUser(app, {
      email: 'measures-e2e@example.com',
      password: 'correct-horse-battery',
    });
    cookie = admin.cookie;
    tenantId = admin.tenantId;

    // Co-tenanting the member the same way `metric-policies.e2e-spec.ts` does — both callers see
    // the same seeded rows, so only the role is the variable under test.
    const member = await registerTestUser(
      app,
      { email: 'measures-member-e2e@example.com', password: 'correct-horse-battery' },
      { role: 'member', tenantId },
    );
    memberCookie = member.cookie;

    answerModel = app.get<Model<AnswerDocument>>(getModelToken(Answer.name));
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
    evidenceChunkModel = app.get<Model<EvidenceChunkDocument>>(getModelToken(EvidenceChunk.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  // `createdAt`/`updatedAt` are set through the raw MongoDB driver, past Mongoose entirely:
  // Mongoose's own timestamps plugin resets `updatedAt` to "now" on every `save()`, including the
  // first one, so a hand-picked completion latency can only be made to stick this way.
  const seedCompletedAnswer = async (
    outcome:
      | { kind: 'answered'; claims: [] }
      | { kind: 'insufficient_evidence'; reason: string; reasonCode: 'no_relevant_evidence' },
    retrievedChunkIds: string[],
    createdAt: Date,
    updatedAt: Date,
  ): Promise<AnswerDocument> => {
    const seeded = await answerModel.create({
      tenantId,
      questionText: 'What is the cap rate?',
      runStatus: 'completed',
      outcome,
      claims: [],
      retrievedChunkIds,
    });
    await answerModel.collection.updateOne({ _id: seeded._id }, { $set: { createdAt, updatedAt } });
    return seeded;
  };

  // Direct model write, following `documents.e2e-spec.ts`'s `seedChunk` pattern — no route creates
  // a chunk row directly.
  const seedChunk = (chunkId: string, documentId: Types.ObjectId) =>
    evidenceChunkModel.create({
      _id: chunkId,
      documentId,
      documentVersionId: new Types.ObjectId(),
      tenantId,
      text: 'chunk text',
      tokenCount: 100,
      embedding: [0.1, 0.2, 0.3],
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      ingestionAttemptToken: new Types.ObjectId(),
    });

  describe('GET /measures', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/measures');

      expect(response.status).toBe(401);
    });

    it('is reachable by a Member — every figure is a tenant-scoped aggregate a member can already reach by browsing', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/measures')
        .set('Cookie', memberCookie);

      expect(response.status).toBe(200);
    });

    it('exposes exactly the seven contract keys', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/measures')
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body as MeasuresBody).sort()).toEqual(MEASURES_KEYS);
    });

    it('computes every figure from seeded answers and conflicts, using hand-checked latency and document-count expectations', async () => {
      const documentOne = new Types.ObjectId();
      const documentTwo = new Types.ObjectId();
      const chunkOne = `chunk-measures-1-${new Types.ObjectId().toString()}`;
      const chunkTwo = `chunk-measures-2-${new Types.ObjectId().toString()}`;
      const chunkThree = `chunk-measures-3-${new Types.ObjectId().toString()}`;
      const chunkDeleted = `chunk-measures-deleted-${new Types.ObjectId().toString()}`;
      await seedChunk(chunkOne, documentOne);
      await seedChunk(chunkTwo, documentOne);
      await seedChunk(chunkThree, documentTwo);

      const start = new Date('2026-01-01T00:00:00.000Z');
      // Verified citation, two chunks from the same document (distinct count 1) plus one chunk
      // whose document has since been deleted (contributes no document, does not throw).
      await seedCompletedAnswer(
        { kind: 'answered', claims: [] },
        [chunkOne, chunkTwo, chunkDeleted],
        start,
        new Date(start.getTime() + 1000),
      );
      // Not verified — the grounding gate dropped every citation — one chunk from a second
      // document.
      await seedCompletedAnswer(
        {
          kind: 'insufficient_evidence',
          reason: 'No supporting evidence was retrieved.',
          reasonCode: 'no_relevant_evidence',
        },
        [chunkThree],
        start,
        new Date(start.getTime() + 3000),
      );
      // Never counted: still running, so it carries no outcome and no completion latency.
      await answerModel.create({
        tenantId,
        questionText: 'What is the vacancy rate?',
        runStatus: 'queued',
      });

      const factKey = { entity: 'Measures Test Entity', metric: 'cap_rate', period: '2026-01' };
      await conflictModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        magnitude: 0.01,
        magnitudeUnit: 'ratio',
        packId: 'cre',
        packVersion: 1,
        status: 'open',
      });
      await conflictModel.create({
        tenantId,
        factKey,
        groupKeyNormalized: groupKey(factKey),
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        magnitude: 0.02,
        magnitudeUnit: 'ratio',
        packId: 'cre',
        packVersion: 1,
        status: 'resolved',
        resolution: {
          outcome: 'resolved',
          winningFactId: new Types.ObjectId(),
          resolvedAt: new Date(),
        },
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/measures')
        .set('Cookie', cookie);
      const body = response.body as MeasuresBody;

      expect(response.status).toBe(200);
      expect(body.answersCompleted).toBe(2);
      expect(body.answersWithVerifiedCitations).toBe(1);
      expect(body.conflictsSurfaced).toBe(2);
      expect(body.conflictsResolved).toBe(1);
      // Distinct documents per answer: 1 (chunkOne/chunkTwo both resolve to documentOne,
      // chunkDeleted resolves to nothing), 1 (chunkThree resolves to documentTwo). Mean 2/2 = 1.
      expect(body.meanEvidenceDocumentsPerAnswer).toBe(1);
      // Sorted latencies [1000, 3000]. Median: rank = 0.5 * 1 = 0.5 -> 1000 + (3000-1000)*0.5 = 2000.
      expect(body.medianAnswerLatencyMs).toBe(2000);
      // p95: rank = 0.95 * 1 = 0.95 -> 1000 + (3000-1000)*0.95 = 2900.
      expect(body.p95AnswerLatencyMs).toBe(2900);
    });

    it('scopes every figure to the caller tenant — a second tenant with no data of its own sees zeros and nulls, not tenant A leakage', async () => {
      const otherTenant = await registerTestUser(app, {
        email: 'measures-other-tenant-e2e@example.com',
        password: 'correct-horse-battery',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/measures')
        .set('Cookie', otherTenant.cookie);
      const body = response.body as MeasuresBody;

      expect(response.status).toBe(200);
      expect(body).toEqual({
        answersCompleted: 0,
        answersWithVerifiedCitations: 0,
        conflictsSurfaced: 0,
        conflictsResolved: 0,
        meanEvidenceDocumentsPerAnswer: null,
        medianAnswerLatencyMs: null,
        p95AnswerLatencyMs: null,
      });
    });
  });
});
