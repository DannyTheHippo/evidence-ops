export interface TelemetryEvent {
  readonly name: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * `TELEMETRY` binds to `LoggerTelemetry`, which writes each event through `AppLogger`. This is a
 * discrete event sink, separate from the OTel metrics pipeline (`src/instrumentation.ts`,
 * `domain-metrics.ts`) — an event emitted here is not also exported as a metric, and vice versa.
 */
export interface Telemetry {
  event(event: TelemetryEvent): void;
}

export const TELEMETRY = Symbol('TELEMETRY');
