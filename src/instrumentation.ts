import 'dotenv/config';

import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
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
 * Service identity (`service.name`) is set per-process via the `OTEL_SERVICE_NAME` env var in each
 * script and compose service (`evidence-ops-api` / `evidence-ops-worker` / `evidence-ops-mcp`), not
 * here: `NodeSDK`'s default resource detection already reads that standard OTel variable, and this
 * file is shared by all three processes, so it cannot know which one it is at authoring time —
 * except for the one place below where each process's metrics port has to differ, which reads
 * `telemetry.serviceName` (the same env var, forwarded through the sanctioned parser like every
 * other value here) rather than guessing.
 *
 * Explicit registration only (never `getNodeAutoInstrumentations`): the task calls out http,
 * express, and mongoose by name — auto-instrumentation pulls in dozens of libraries this codebase
 * doesn't use.
 */
const { telemetry } = validateEnvironment(process.env);

// All three application processes load this same file and can run on one host at once, so a single
// `METRICS_PORT` (not one independently-set env var per process, which could drift apart) is the
// only source of truth; each process derives its own port by offsetting that base. A fourth process
// is a fourth entry here, keyed by the `OTEL_SERVICE_NAME` its script and compose service set.
const METRICS_PORT_OFFSETS = new Map([
  ['evidence-ops-api', 0],
  ['evidence-ops-worker', 1],
  ['evidence-ops-mcp', 2],
]);
const metricsPortOffset = METRICS_PORT_OFFSETS.get(telemetry.serviceName ?? '');

// A name with no offset gets no exporter at all, and the process still starts: metrics measure the
// application, so a gap in them must never stop it. Binding the base port as a fallback is the one
// option ruled out — that port belongs to the API, and a second listener on it either loses its own
// metrics to `EADDRINUSE` or takes the API's away, both of which the exporter reports only through
// `diag`, which nothing here configures. The warning is the signal instead, and a process that
// serves no metrics leaves its Prometheus target `down` rather than corrupting another's.
if (metricsPortOffset === undefined) {
  console.warn(
    `No metrics port offset is defined for OTEL_SERVICE_NAME="${telemetry.serviceName ?? ''}"; ` +
      'this process starts without a Prometheus exporter. Known names: ' +
      `${[...METRICS_PORT_OFFSETS.keys()].join(', ')}.`,
  );
}

const metricReaders =
  metricsPortOffset === undefined
    ? []
    : [new PrometheusExporter({ port: telemetry.metricsPort + metricsPortOffset })];

const sdk = new NodeSDK({
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${telemetry.otlpEndpoint}/v1/traces` })),
    // Simple, not Batch: a committed trace artifact (`artifacts/traces/`) should reflect every
    // span as it completes, not whatever survived the last batch flush before process exit.
    new SimpleSpanProcessor(new OtlpFileSpanExporter()),
  ],
  // Process liveness comes free from Prometheus's own `up` series once a scrape target names this
  // process's port — no bespoke heartbeat metric needed.
  metricReaders,
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
