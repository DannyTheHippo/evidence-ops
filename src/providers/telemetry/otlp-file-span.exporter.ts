import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const TRACES_DIR = join(process.cwd(), 'artifacts', 'traces');

/**
 * There is no official OTLP file exporter in the JS SDK (HTTP and gRPC only). This serializes
 * each export batch through `JsonTraceSerializer` — the same encoder `@opentelemetry/exporter-
 * trace-otlp-http` uses internally — so the on-disk format is real OTLP JSON, not a bespoke shape,
 * appended one export-batch-per-line so the file stays valid to scan without loading it whole.
 * Registered via `SimpleSpanProcessor` (see `instrumentation.ts`), not `BatchSpanProcessor`: a
 * committed trace artifact should reflect every span as it completes, not whatever survived the
 * last batch flush before the process exits.
 */
export class OtlpFileSpanExporter implements SpanExporter {
  private readonly filePath: string;

  constructor() {
    mkdirSync(TRACES_DIR, { recursive: true });
    this.filePath = join(TRACES_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      const serialized = JsonTraceSerializer.serializeRequest(spans);
      if (serialized) {
        appendFileSync(this.filePath, `${Buffer.from(serialized).toString('utf8')}\n`);
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Intentionally empty: the interface is async, but every `export()` above already writes
  // synchronously, so there is no buffered state left to flush.
  async shutdown(): Promise<void> {}
}
