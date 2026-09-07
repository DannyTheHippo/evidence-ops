import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { TypedConfigService } from '../config/environment/typed-config.service';
import { IngestionService } from '../features/evidence/ingestion/ingestion.service';
import { INGEST_SCHEDULE_TO_CLOSE_TIMEOUT_MS } from '../workflows/ingest-retry-policy';
import { createActivities } from './activities';
import { WorkerModule } from './worker.module';

/**
 * How often the worker sweeps versions abandoned mid-ingest into `failed`
 * (`IngestionService.reconcileStaleAttempts`). Well under the staleness threshold it sweeps
 * against, so a lost attempt is visible within minutes of becoming provably lost rather than at
 * the next deploy.
 */
const RECONCILE_INTERVAL_MS = 60 * 1000;

/**
 * Second process, per ADR-0003. Boots the same DI graph as the API (`WorkerModule` mirrors the
 * slice of `AppModule` activities need), then starts a Temporal `Worker` polling the configured
 * task queue. `workflowsPath` points at `src/workflows` — the webpack-based `bundleWorkflowCode`
 * that runs inside `Worker.create` is the authoritative half of the determinism fence: it
 * resolves the whole module graph and rejects a forbidden import the ESLint zone over
 * `src/workflows/**` can't see (e.g. a Node builtin reached transitively through a package).
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const config = app.get(TypedConfigService);

  const connection = await NativeConnection.connect({ address: config.temporal.address });
  // An activity whose process is killed outright runs no catch anywhere, so the version it claimed
  // stays `pending` with a live lease and nobody is waiting on it. This sweep is the only thing
  // that can see that case; `reconcileStaleAttempts` swallows its own write failures, so a bad
  // pass costs the next interval, never the worker.
  const ingestionService = app.get(IngestionService);
  const reconciler = setInterval(() => {
    void ingestionService
      .reconcileStaleAttempts(INGEST_SCHEDULE_TO_CLOSE_TIMEOUT_MS)
      .then((swept) => {
        if (swept > 0) {
          Logger.log(`Swept ${swept} abandoned ingestion attempt(s) to 'failed'`, 'Worker');
        }
      });
  }, RECONCILE_INTERVAL_MS);

  try {
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.taskQueue,
      workflowsPath: require.resolve('../workflows'),
      activities: createActivities(app),
      maxConcurrentActivityTaskExecutions: config.temporal.maxConcurrentActivityTaskExecutions,
    });

    Logger.log(
      `Worker polling task queue '${config.temporal.taskQueue}' at '${config.temporal.address}'`,
      'Worker',
    );

    // Resolves on graceful shutdown (SIGINT/SIGTERM, the default `shutdownSignals`), rejects on
    // an unrecoverable worker error — either way, control returns here rather than the process
    // just dying, which is what lets the `finally` below close the connection and the Nest
    // context cleanly.
    await worker.run();
  } finally {
    clearInterval(reconciler);
    await connection.close();
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error('Fatal worker failure:', error);
  process.exit(1);
});
