import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { stopInMemoryMongo } from '../src/config/mongo.config';
import { TypedConfigService } from '../src/config/environment/typed-config.service';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../src/providers/embedding/embedding-provider.interface';
import { VoyageEmbeddingProvider } from '../src/providers/embedding/voyage-embedding.provider';
import {
  MODEL_CACHE_OPTIONS,
  type CachingModelProviderOptions,
} from '../src/providers/model/caching-model.provider';
import { FakeWorkflowEngine } from '../src/providers/workflow-engine/fake-workflow.engine';
import { WORKFLOW_ENGINE } from '../src/providers/workflow-engine/workflow-engine.interface';
import { CachingEmbeddingProvider } from './providers/caching-embedding.provider';

export type EvalCacheMode = 'record' | 'replay';

export interface BootstrapEvalAppOptions {
  readonly cacheMode: EvalCacheMode;
  readonly modelCacheDir: string;
  readonly embeddingCacheDir: string;
}

/**
 * Boots the real `AppModule` DI graph — the same one `main.ts`/`worker/main.ts` use — through
 * `Test.createTestingModule`, mirroring `test/utils/create-test-app.ts`'s precedent for exactly
 * the reason that file documents: `ProvidersModule` binds the real `TemporalWorkflowEngine`, and
 * `NestFactory.createApplicationContext` (`scripts/smoke-providers.ts`'s pattern) has no
 * `overrideProvider`. Three overrides, all decorator-seam swaps rather than new wiring:
 *
 * - `MODEL_CACHE_OPTIONS` — `ProvidersModule` binds this `off` by default (deliberately: "turning
 *   on record/replay is an eval-harness/script decision", per that module's own comment). This is
 *   that decision.
 * - `EMBEDDING_PROVIDER` — wraps the real `VoyageEmbeddingProvider` in `CachingEmbeddingProvider`,
 *   the model-cache decorator's counterpart for embeddings (see that file's doc comment for why a
 *   second cache is needed at all).
 * - `WORKFLOW_ENGINE` — swapped to `FakeWorkflowEngine` so nothing in the DI graph can reach a live
 *   Temporal server, even though `eval/run.ts` never calls `start()`/`status()` on it directly
 *   (ingestion goes through `eval/ingest-fixtures.ts`, which bypasses the workflow entirely).
 */
export async function bootstrapEvalApp(
  options: BootstrapEvalAppOptions,
): Promise<INestApplicationContext> {
  const modelCacheOptions: CachingModelProviderOptions = {
    mode: options.cacheMode,
    cacheDir: options.modelCacheDir,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MODEL_CACHE_OPTIONS)
    .useValue(modelCacheOptions)
    .overrideProvider(EMBEDDING_PROVIDER)
    .useFactory({
      inject: [TypedConfigService],
      factory: (config: TypedConfigService): EmbeddingProvider =>
        new CachingEmbeddingProvider(new VoyageEmbeddingProvider(config), {
          mode: options.cacheMode,
          cacheDir: options.embeddingCacheDir,
        }),
    })
    .overrideProvider(WORKFLOW_ENGINE)
    .useClass(FakeWorkflowEngine)
    .compile();

  await moduleRef.init();
  return moduleRef;
}

/** Mirrors `test/utils/create-test-app.ts`'s `closeTestApp`: `app.close()` alone leaves an
 * in-memory mongod running when `MONGO_MEMORY_SERVER=true`. */
export async function closeEvalApp(app: INestApplicationContext): Promise<void> {
  await app.close();
  await stopInMemoryMongo();
}
