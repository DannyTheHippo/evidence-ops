import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry-v2';

/**
 * Builds a fresh `OpenTelemetryPlugin` per caller (`TemporalWorkflowEngine.getClient()`,
 * `worker/main.ts`) rather than a shared singleton — client and worker are always different
 * processes, so there is never an instance to actually share, and reaching into
 * `../../instrumentation` here to reuse *its* processor would re-run that file's `sdk.start()`
 * side effect a second time in-process, including inside every unit test that imports this
 * factory transitively.
 *
 * Registering the plugin on both `Client` and `Worker.create` is what makes the trace span the
 * ADR-0003 determinism boundary: the plugin's client interceptor injects the active trace context
 * into workflow-start headers, and its worker-side interceptors (activity + a workflow-sandbox
 * module the plugin bundles internally, via `Worker.create`'s own config — never an import inside
 * `src/workflows/**`) propagate that context into every activity call.
 *
 * Only the OTLP exporter is wired here, not the file exporter `instrumentation.ts` also
 * registers: the handful of workflow-sandbox spans this plugin exports (Temporal's Sink
 * mechanism, internal to the package) are "this workflow ran" spans, not the evidence-bearing
 * ones — mirroring them to the committable file artifact isn't worth a second `SpanProcessor`
 * implementation (`MultiSpanProcessor` isn't part of `@opentelemetry/sdk-trace-base`'s public
 * API). Activity spans still reach both destinations: activities run in the normal Node process,
 * so `OpenTelemetryActivityInboundInterceptor` uses the tracer this process's own `instrumentation.ts`
 * already registered globally.
 */
export function createTemporalOtelPlugin(
  serviceName: string,
  otlpEndpoint: string,
): OpenTelemetryPlugin {
  return new OpenTelemetryPlugin({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    ),
  });
}
