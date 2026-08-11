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
import type { Citation } from '../../src/features/evidence/qa/contracts/answer.contract';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

interface AnswerBody {
  id: string;
  questionText?: string;
  runStatus: string;
  outcome?: unknown;
  claimCoverage?: number;
  citations?: unknown[];
  conflictIds?: string[];
  createdAt?: string;
}

interface ConflictBody {
  id: string;
  factKey: { entity: string; metric: string; period: string };
  factIds: string[];
  magnitude: number;
  status: string;
  createdAt: string;
}

describe('QA and Conflicts (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let userId: string;
  let answerModel: Model<AnswerDocument>;
  let auditEventModel: Model<AuditEventDocument>;
  let conflictModel: Model<ConflictDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'qa-e2e@example.com', password: 'correct-horse-battery' };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(credentials);
    const login = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    token = (login.body as { accessToken: string }).accessToken;
    const me = await request(getTestServer(app))
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    userId = (me.body as { id: string }).id;

    answerModel = app.get<Model<AnswerDocument>>(getModelToken(Answer.name));
    auditEventModel = app.get<Model<AuditEventDocument>>(getModelToken(AuditEvent.name));
    conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
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
        .set('Authorization', `Bearer ${token}`)
        .send({ questionText: 'What is the cap rate?', notAField: 'x' });

      expect(response.status).toBe(400);
    });

    it('starts a queued answer, exposing only id and runStatus, and records an audit event', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/questions')
        .set('Authorization', `Bearer ${token}`)
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
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });

    it('returns 404 for a well-formed id with no matching Answer', async () => {
      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${new Types.ObjectId().toString()}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
    });

    it('presents a queued answer with no outcome/claimCoverage keys at all, and records an audit event', async () => {
      const started = await request(getTestServer(app))
        .post('/api/v1/questions')
        .set('Authorization', `Bearer ${token}`)
        .send({ questionText: 'What is the vacancy rate?' });
      const answerId = (started.body as AnswerBody).id;

      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${answerId}`)
        .set('Authorization', `Bearer ${token}`);
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
      const seeded = await answerModel.create({
        questionText: 'What is the cap rate?',
        runStatus: 'completed',
        outcome: {
          kind: 'answered',
          claims: [{ statement: 'The cap rate is approximately 6.10%.', citations: [citation] }],
        },
        claims: [{ statement: 'The cap rate is approximately 6.10%.', citations: [citation] }],
        claimCoverage: 0.8,
      });

      const response = await request(getTestServer(app))
        .get(`/api/v1/answers/${seeded._id.toString()}`)
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as AnswerBody;

      expect(response.status).toBe(200);
      expect(body.runStatus).toBe('completed');
      expect(body.claimCoverage).toBe(0.8);
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
          'citations',
          'conflictIds',
          'createdAt',
        ].sort(),
      );
    });

    // Regression for the "conflicting_evidence unreachable" gap (ADR-0004 bound 9): `reasonCode`
    // is a new field on `outcome` for `insufficient_evidence` — an exact `toEqual` here is the
    // only gate that would catch it silently missing `@Expose()` (it would not: `outcome` passes
    // through as a whole object, not per-field, but the assertion still proves the wire shape).
    it('presents a model-authored reasonCode on an insufficient_evidence outcome once completed', async () => {
      const seeded = await answerModel.create({
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
        .set('Authorization', `Bearer ${token}`);
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

  describe('GET /conflicts', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app)).get('/api/v1/conflicts');

      expect(response.status).toBe(401);
    });

    it('lists conflicts with a count, exposing the exact conflict key set, and records an audit event', async () => {
      const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
      await conflictModel.create({
        factKey,
        factIds: [new Types.ObjectId(), new Types.ObjectId()],
        magnitude: 0.0085,
        status: 'open',
      });

      const response = await request(getTestServer(app))
        .get('/api/v1/conflicts')
        .set('Authorization', `Bearer ${token}`);
      const body = response.body as { docs: ConflictBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBeGreaterThan(0);
      expect(body.docs.length).toBeGreaterThan(0);
      expect(Object.keys(body.docs[0]).sort()).toEqual(
        ['id', 'factKey', 'factIds', 'magnitude', 'status', 'createdAt'].sort(),
      );

      const events = await auditEventModel.find({ action: 'conflicts.listed' });
      expect(events.length).toBeGreaterThan(0);
    });
  });
});
