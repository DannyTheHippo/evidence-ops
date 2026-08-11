import 'dotenv/config';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MongooseInstrumentation } from '@opentelemetry/instrumentation-mongoose';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { validateEnvironment } from './config/environment/environment.config';
import { OtlpFileSpanExporter } from './providers/telemetry/otlp-file-span.exporter';

/**
 * `--import`/`-r` entrypoint (see the `start*`/`worker:dev` scripts in `package.json`), loaded
 * before `main.ts`/`worker/main.ts` so every http/express/mongoose call the process makes is
 * instrumented from the first request. `dotenv/config` runs here too, as the first statement,
 * because `--import` executes before `main.ts`'s own `import 'dotenv/config'` line — the OTLP
 * endpoint read below needs `.env` already loaded; re-loading it again in `main.ts` is a harmless
 * no-op (`dotenv` never overwrites an already-set var).
 *
 * `validateEnvironment(process.env)` rather than injecting `TypedConfigService`: this file runs
 * before Nest builds a DI graph, so injection isn't available yet. The "process.env read in
 * exactly one file" rule stays intact — the raw property reads still happen inside
 * `environment.config.ts`; this file only forwards the object into the sanctioned parser.
 *
 * Service identity (`service.name`) is set per-process via the `OTEL_SERVICE_NAME` env var in
 * each script (`evidence-ops-api` / `evidence-ops-worker`), not here: `NodeSDK`'s default resource
 * detection already reads that standard OTel variable, and this file is shared by both processes,
 * so it cannot know which one it is at authoring time.
 *
 * Explicit registration only (never `getNodeAutoInstrumentations`): the task calls out http,
 * express, and mongoose by name — auto-instrumentation pulls in dozens of libraries this codebase
 * doesn't use.
 */
const { telemetry } = validateEnvironment(process.env);

const sdk = new NodeSDK({
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${telemetry.otlpEndpoint}/v1/traces` })),
    // Simple, not Batch: a committed trace artifact (`artifacts/traces/`) should reflect every
    // span as it completes, not whatever survived the last batch flush before process exit.
    new SimpleSpanProcessor(new OtlpFileSpanExporter()),
  ],
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new MongooseInstrumentation(),
  ],
});

sdk.start();

// Flush both processors (OTLP batch + file) before the process actually exits — the batch
// processor otherwise drops whatever hadn't hit its flush interval yet.
['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => {
    void sdk.shutdown();
  });
});
