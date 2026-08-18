import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
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
}

const RETRIEVED_CHUNK_KEYS = ['chunkId', 'docVersionId', 'sha256', 'text', 'locator'].sort();

describe('Retrieval (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let tenantId: string;
  let fakeRetrievalStore: FakeRetrievalStore;
  let documentVersionModel: Model<DocumentVersionDocument>;

  beforeAll(async () => {
    app = await createTestApp();

    const credentials = { email: 'retrieval-e2e@example.com', password: 'correct-horse-battery' };
    ({ cookie, tenantId } = await registerTestUser(app, credentials));

    fakeRetrievalStore = app.get<FakeRetrievalStore>(RETRIEVAL_STORE);
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

    it('returns hits as { docs, count } with the exact chunk key set, scoped to the caller tenant', async () => {
      const version = await documentVersionModel.create({
        tenantId,
        documentId: new Types.ObjectId(),
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
            documentVersionId: version._id.toString(),
            tenantId,
          },
        },
      ]);

      const response = await request(getTestServer(app))
        .get('/api/v1/retrieval/search')
        .set('Cookie', cookie)
        .query({ query: 'What is the cap rate?' });
      const body = response.body as { docs: RetrievedChunkBody[]; count: number };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['docs', 'count'].sort());
      expect(body.count).toBe(1);
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].chunkId).toBe('chunk-1');
      expect(body.docs[0].docVersionId).toBe(version._id.toString());
      expect(body.docs[0].sha256).toBe(version.sha256);
      // Asserting the exact key set is the only gate that catches a response-DTO field missing
      // @Expose() — such a field is silently dropped from the payload with no error anywhere.
      expect(Object.keys(body.docs[0]).sort()).toEqual(RETRIEVED_CHUNK_KEYS);

      // The one predicate `tenantScopePlugin` structurally cannot backstop here — it does not
      // hook `aggregate()`, so the store's filter is the only place tenant scoping is provable.
      expect(fakeRetrievalStore.queries[0].filter).toEqual({ tenantId });
    });
  });

  // Placed at the very end of this suite deliberately: the per-handler throttle bucket persists
  // across every earlier `search` call above, so exhausting it here would 429 those tests if this
  // block ran before them.
  describe('GET /retrieval/search throttling', () => {
    it('returns 429 after exceeding the search throttle', async () => {
      fakeRetrievalStore.setHits([]);
      let lastStatus: number | undefined;

      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await request(getTestServer(app))
          .get('/api/v1/retrieval/search')
          .set('Cookie', cookie)
          .query({ query: 'throttle probe' });
        lastStatus = response.status;
      }

      expect(lastStatus).toBe(429);
    });
  });
});
