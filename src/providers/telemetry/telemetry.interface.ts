export interface TelemetryEvent {
  readonly name: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * `TELEMETRY` binds to `LoggerTelemetry`, which writes each event through `AppLogger`. This is
 * a discrete event sink, separate from the OTel span pipeline (`src/instrumentation.ts`): request
 * tracing is instrumented at the process level and does not flow through `Telemetry.event()`.
 * Callers should not assume an event emitted here is also exported as a trace span.
 */
export interface Telemetry {
  event(event: TelemetryEvent): void;
}

export const TELEMETRY = Symbol('TELEMETRY');
