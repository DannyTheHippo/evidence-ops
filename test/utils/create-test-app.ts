import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import type request from 'supertest';
import { AppModule } from '../../src/app.module';
import { createApplicationConfig } from '../../src/config/app.config';
import { stopInMemoryMongo } from '../../src/config/mongo.config';
import { FakeRetrievalStore } from '../../src/providers/retrieval/fake-retrieval.store';
import { RETRIEVAL_STORE } from '../../src/providers/retrieval/retrieval-store.interface';
import { FakeWorkflowEngine } from '../../src/providers/workflow-engine/fake-workflow.engine';
import { WORKFLOW_ENGINE } from '../../src/providers/workflow-engine/workflow-engine.interface';

type TestServer = Parameters<typeof request>[0];

/**
 * Boots the real Nest app (helmet, CORS, global prefix, versioning, validation pipe —
 * the same pipeline `main.ts` wires up) against an in-memory Mongo replica set.
 *
 * Relies on `test/e2e/setup-env.ts` (Jest `setupFiles`) having already forced
 * `MONGO_MEMORY_SERVER=true` before this module — or any spec file — is loaded:
 * `AppConfigModule`'s `ConfigModule.forRoot()` reads and validates `process.env`
 * synchronously the moment it's first evaluated, at `AppModule`'s import above.
 *
 * `WORKFLOW_ENGINE` is overridden back to `FakeWorkflowEngine`: `ProvidersModule` binds the real
 * `TemporalWorkflowEngine` there (ADR-0003), and e2e must not require a live Temporal server.
 *
 * `RETRIEVAL_STORE` is overridden back to `FakeRetrievalStore` for the same reason: `ProvidersModule`
 * binds the real `MongoHybridRetrievalStore`, which runs `$search`/`$vectorSearch`/`$rankFusion`
 * against Mongo — operators `mongodb-memory-server` does not support. `RetrievalController` is the
 * first e2e-reachable, synchronous caller of that store, so without this override its request
 * throws the moment `mongodb-memory-server` rejects the aggregation.
 */
export const createTestApp = async (): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WORKFLOW_ENGINE)
    .useClass(FakeWorkflowEngine)
    .overrideProvider(RETRIEVAL_STORE)
    .useClass(FakeRetrievalStore)
    .compile();

  const app = moduleRef.createNestApplication();
  await createApplicationConfig(app);
  await app.init();

  await syncModelIndexes(app);

  return app;
};

/**
 * Builds every index the registered schemas declare against the in-memory database.
 *
 * Indexes reach a deployed database through `migrations/`, which no jest lane runs, so without this
 * an e2e suite exercises a database with no unique constraints at all — a duplicate insert that
 * production rejects with a duplicate-key error succeeds silently in tests, and the 409 contract
 * built on top of it can never be asserted.
 *
 * Failures are swallowed deliberately: this is test-harness setup, not a gate. An index that cannot
 * be built must not stop the suite from running the assertions that do not depend on it.
 */
const syncModelIndexes = async (app: INestApplication): Promise<void> => {
  const connection = app.get<Connection>(getConnectionToken());

  await Promise.all(
    Object.values(connection.models).map((model) =>
      model.syncIndexes().catch(() => {
        return undefined;
      }),
    ),
  );
};

/**
 * Nest types `getHttpServer()` as `any`, which otherwise leaks an unsafe value into every
 * `request(...)` call in every spec. The one cast lives here, at the single boundary where
 * the concrete type is actually known, instead of being suppressed at each call site.
 */
export const getTestServer = (app: INestApplication): TestServer =>
  app.getHttpServer() as TestServer;

/**
 * Tears down everything `createTestApp` brought up. `app.close()` alone leaves the in-memory
 * mongod running, which keeps the Jest worker alive past the suite.
 */
export const closeTestApp = async (app: INestApplication): Promise<void> => {
  await app.close();
  await stopInMemoryMongo();
};
