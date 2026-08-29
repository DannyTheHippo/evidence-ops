import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import {
  Document,
  DocumentDocument,
} from '../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import { FakeRetrievalStore } from '../../src/providers/retrieval/fake-retrieval.store';
import { RETRIEVAL_STORE } from '../../src/providers/retrieval/retrieval-store.interface';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface RetrievedChunkBody {
  chunkId: string;
  docVersionId: string;
  sha256: string;
  text: string;
  locator: unknown;
  documentId: string;
  documentTitle: string;
  sourceClass: string;
  documentCreatedAt: string;
  score: number;
}

const RETRIEVED_CHUNK_KEYS = [
  'chunkId',
  'docVersionId',
  'sha256',
  'text',
  'locator',
  'documentId',
  'documentTitle',
  'sourceClass',
  'documentCreatedAt',
  'score',
].sort();

describe('Retrieval (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let tenantId: string;
  let fakeRetrievalStore: FakeRetrievalStore;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'retrieval-e2e@example.com', password: 'correct-horse-battery' };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    fakeRetrievalStore = app.get<FakeRetrievalStore>(RETRIEVAL_STORE);
    documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
    documentVersionModel = app.get<Model<DocumentVersionDocument>>(
      getModelToken(DocumentVersion.name),
    );
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /retrieval/search', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .query({ query: 'cap rate' });

      expect(response.status).toBe(401);
    });

    it('returns 400 for an empty query', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: '' });

      expect(response.status).toBe(400);
    });

    it('returns 400 for a query over 500 characters', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'a'.repeat(501) });

      expect(response.status).toBe(400);
    });

    it('returns 400 for an unknown field', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'cap rate', unknownField: 'nope' });

      expect(response.status).toBe(400);
    });

    it('returns hits as { docs, hasMore } with the exact chunk key set, scoped to the caller tenant', async () => {
      const document = await documentModel.create({
        title: 'Northgate Business Park — Q3 Rent Roll',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        tenantId,
      });
      const version = await documentVersionModel.create({
        tenantId,
        documentId: document._id,
        versionNumber: 1,
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        storageKey: 'retrieval-e2e-v1',
      });
      fakeRetrievalStore.setHits([
        {
          id: 'chunk-1',
          score: 1,
          metadata: {
            text: 'The cap rate for Northgate Business Park is approximately 6.10%.',
            locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
            documentId: document._id.toString(),
            documentVersionId: version._id.toString(),
            tenantId,
          },
        },
      ]);

      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'What is the cap rate?' });
      const body = response.body as { docs: RetrievedChunkBody[]; hasMore: boolean };

      expect(response.status).toBe(200);
      // { docs, hasMore }, not { docs, count }: paging applies after fusion, the score floor,
      // and withdrawn-version filtering, none of which yield a cheap exact total — see
      // `SearchEvidenceResponseDto`'s own doc comment.
      expect(Object.keys(body).sort()).toEqual(['docs', 'hasMore'].sort());
      expect(body.hasMore).toBe(false);
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].chunkId).toBe('chunk-1');
      expect(body.docs[0].docVersionId).toBe(version._id.toString());
      expect(body.docs[0].sha256).toBe(version.sha256);
      expect(body.docs[0].documentId).toBe(document._id.toString());
      expect(body.docs[0].documentTitle).toBe(document.title);
      expect(body.docs[0].sourceClass).toBe(document.sourceClass);
      expect(body.docs[0].documentCreatedAt).toBe(document.createdAt.toISOString());
      expect(body.docs[0].score).toBe(1);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body.docs[0]).sort()).toEqual(RETRIEVED_CHUNK_KEYS);

      // The one predicate `tenantScopePlugin` structurally cannot backstop here — it does not
      // hook `aggregate()`, so the store's filter is the only place tenant scoping is provable.
      expect(fakeRetrievalStore.queries[0].filter).toEqual({ tenantId });
    });

    it('pages the ranked result with skip/limit and reports hasMore', async () => {
      const document = await documentModel.create({
        title: 'Paging Fixture',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        tenantId,
      });
      const versions = await Promise.all(
        [1, 2, 3].map((versionNumber) =>
          documentVersionModel.create({
            tenantId,
            documentId: document._id,
            versionNumber,
            sha256: `${versionNumber}`.repeat(64).slice(0, 64),
            sizeBytes: 100,
            storageKey: `retrieval-e2e-paging-v${versionNumber}`,
          }),
        ),
      );
      fakeRetrievalStore.setHits(
        versions.map((version, index) => ({
          id: `chunk-page-${index}`,
          score: 1 - index * 0.1,
          metadata: {
            text: `Chunk ${index}`,
            locator: { kind: 'pdf-page', page: index + 1, extractorVersion: 'v1' },
            documentId: document._id.toString(),
            documentVersionId: version._id.toString(),
            tenantId,
          },
        })),
      );

      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'paging probe', skip: 1, limit: 1 });
      const body = response.body as { docs: RetrievedChunkBody[]; hasMore: boolean };

      expect(response.status).toBe(200);
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].chunkId).toBe('chunk-page-1');
      expect(body.hasMore).toBe(true);
    });

    it('filters to documents whose sourceClass matches, excluding a document of a different class', async () => {
      const memoDocument = await documentModel.create({
        title: 'Memo',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        sourceClass: 'memo',
        tenantId,
      });
      const reportDocument = await documentModel.create({
        title: 'Report',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        sourceClass: 'report',
        tenantId,
      });
      const memoVersion = await documentVersionModel.create({
        tenantId,
        documentId: memoDocument._id,
        versionNumber: 1,
        sha256: 'c'.repeat(64),
        sizeBytes: 100,
        storageKey: 'retrieval-e2e-memo-v1',
      });
      const reportVersion = await documentVersionModel.create({
        tenantId,
        documentId: reportDocument._id,
        versionNumber: 1,
        sha256: 'd'.repeat(64),
        sizeBytes: 100,
        storageKey: 'retrieval-e2e-report-v1',
      });
      fakeRetrievalStore.setHits([
        {
          id: 'chunk-memo',
          score: 1,
          metadata: {
            text: 'Memo text',
            locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
            documentId: memoDocument._id.toString(),
            documentVersionId: memoVersion._id.toString(),
            tenantId,
          },
        },
        {
          id: 'chunk-report',
          score: 0.9,
          metadata: {
            text: 'Report text',
            locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
            documentId: reportDocument._id.toString(),
            documentVersionId: reportVersion._id.toString(),
            tenantId,
          },
        },
      ]);

      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'source class probe', sourceClass: 'memo' });
      const body = response.body as { docs: RetrievedChunkBody[]; hasMore: boolean };

      expect(response.status).toBe(200);
      expect(body.docs.map((doc) => doc.chunkId)).toEqual(['chunk-memo']);
    });

    it('returns 400 for a sourceClass outside the documented enum', async () => {
      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'cap rate', sourceClass: 'not-a-real-class' });

      expect(response.status).toBe(400);
    });

    // Regression for the explicit `@RequireRole(Member, Admin)` floor: this route stated no role
    // requirement before, which the `RolesGuard` opt-in default already treated as "any
    // authenticated user", so a Member could always reach it — this proves the explicit floor
    // didn't quietly narrow that to Admin only.
    it('allows a Member to search — the explicit floor grants the same access as before', async () => {
      fakeRetrievalStore.setHits([]);
      const { cookie: memberCookie } = await registerTestUser(
        app,
        { email: 'retrieval-e2e-member@example.com', password: 'correct-horse-battery' },
        { role: 'member', tenantId },
      );

      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', memberCookie)
        .query({ query: 'What is the cap rate?' });

      expect(response.status).toBe(200);
    });
  });

  // Placed at the very end of this suite deliberately: the per-handler throttle bucket persists
  // across every earlier `search` call above, so exhausting it here would 429 those tests if this
  // block ran before them.
  describe('GET /retrieval/search throttling', () => {
    it('returns 429 after exceeding the search throttle, with a readable Retry-After window', async () => {
      fakeRetrievalStore.setHits([]);
      let lastResponse: request.Response | undefined;

      for (let attempt = 0; attempt < 11; attempt += 1) {
        lastResponse = await request(getTestServer(app))
          .get('/api/v1/retrieval/search')
          .set('Cookie', cookie)
          .query({ query: 'throttle probe' });
      }

      expect(lastResponse?.status).toBe(429);
      // `@nestjs/throttler`'s `ThrottlerGuard` sets this itself from the same remaining-TTL value
      // the storage layer tracks — asserting it here is what catches a regression to a flat,
      // client-guessed cooldown rather than the window the server actually enforces.
      const retryAfterSeconds = Number(lastResponse?.headers['retry-after']);
      expect(Number.isFinite(retryAfterSeconds)).toBe(true);
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    // Regression for the defect `UserThrottlerGuard` closes: every request in this suite reaches
    // the app through the same loopback connection, so keying the tracker by IP (the previous
    // default) would put every caller in this bucket regardless of who they are — the exact
    // "one user 429s the whole product" failure. Runs immediately after the test above, whose
    // bucket for `cookie`'s user is already exhausted; a second, different authenticated user must
    // still get through on their very first call.
    it('does not share a throttle bucket between two different authenticated users', async () => {
      fakeRetrievalStore.setHits([]);

      const exhaustedUserResponse = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'throttle probe' });
      expect(exhaustedUserResponse.status).toBe(429);

      const { cookie: otherCookie } = await registerTestUser(app, {
        email: 'retrieval-e2e-other-user@example.com',
        password: 'correct-horse-battery',
      });

      const otherUserResponse = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', otherCookie)
        .query({ query: 'throttle probe' });

      expect(otherUserResponse.status).toBe(200);
    });

    // Regression for the gap `PreAuthThrottlerGuard` closes: before it existed, `JwtAuthGuard`
    // rejected a credential-less request with 401 before `UserThrottlerGuard` (which only ever runs
    // after auth) got a turn, so a burst with no cookie at all never spent any throttle budget and
    // never 429'd. Must run last — it drives this route's pre-auth IP bucket toward its own limit on
    // top of whatever the tests above already spent.
    it('throttles a burst of credential-less requests instead of returning 401 forever', async () => {
      const throttleLimit = Number(process.env.THROTTLE_LIMIT);
      const statuses: number[] = [];

      for (let attempt = 0; attempt < throttleLimit + 5; attempt += 1) {
        const response = await request(getTestServer(app))
          .get('/api/v1/retrieval/search')
          .query({ query: 'throttle probe' });
        statuses.push(response.status);
      }

      // Both halves matter: an early request still 401s (the perimeter guard is not denying
      // wholesale) and a later one 429s (it is actually bounding the credential-less burst).
      expect(statuses).toContain(401);
      expect(statuses).toContain(429);
    });
  });
});
