import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { TypedConfigService } from '../config/environment/typed-config.service';
import { createTemporalOtelPlugin } from '../providers/telemetry/otel-temporal-plugin.factory';
import { createActivities } from './activities';
import { WorkerModule } from './worker.module';

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
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.taskQueue,
      workflowsPath: require.resolve('../workflows'),
      activities: createActivities(app),
      // 'evidence-ops-worker' mirrors the OTEL_SERVICE_NAME this process's own `instrumentation.ts`
      // resolves via the `worker:dev` script, so worker-process spans and this plugin's
      // client/activity/workflow-sandbox interceptor spans report the same service.name.
      plugins: [createTemporalOtelPlugin('evidence-ops-worker', config.telemetry.otlpEndpoint)],
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
    await connection.close();
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error('Fatal worker failure:', error);
  process.exit(1);
});
