export interface TelemetryEvent {
  readonly name: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * Logger-backed for now (`LoggerTelemetry`) — OpenTelemetry lands later. Callers should not
 * assume events are exported anywhere beyond the process log.
 */
export interface Telemetry {
  event(event: TelemetryEvent): void;
}

export const TELEMETRY = Symbol('TELEMETRY');
