import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type request from 'supertest';
import { AppModule } from '../../src/app.module';
import { createApplicationConfig } from '../../src/config/app.config';
import { stopInMemoryMongo } from '../../src/config/mongo.config';

type TestServer = Parameters<typeof request>[0];

/**
 * Boots the real Nest app (helmet, CORS, global prefix, versioning, validation pipe —
 * the same pipeline `main.ts` wires up) against an in-memory Mongo replica set.
 *
 * Relies on `test/e2e/setup-env.ts` (Jest `setupFiles`) having already forced
 * `MONGO_MEMORY_SERVER=true` before this module — or any spec file — is loaded:
 * `AppConfigModule`'s `ConfigModule.forRoot()` reads and validates `process.env`
 * synchronously the moment it's first evaluated, at `AppModule`'s import above.
 */
export const createTestApp = async (): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  await createApplicationConfig(app);
  await app.init();

  return app;
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
