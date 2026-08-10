import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../shared/services/logger/logger.service';
import type { Telemetry, TelemetryEvent } from './telemetry.interface';

/**
 * Correlation ids are already threaded through `AppLogger` via AsyncLocalStorage
 * (`CorrelationMiddleware` + `AsyncLocalStorageMiddleware`); this class only has to log, not
 * re-derive them. Events named `*.error` (see `TracingModelProvider`) log at error level so
 * failures surface in log-level filters without every caller having to know which telemetry
 * events represent a failure.
 */
@Injectable()
export class LoggerTelemetry implements Telemetry {
  constructor(private readonly logger: AppLogger) {
    this.logger.init(LoggerTelemetry.name);
  }

  event(event: TelemetryEvent): void {
    const attributes = event.attributes ?? {};
    if (event.name.endsWith('.error')) {
      this.logger.error(event.name, attributes);
      return;
    }

    this.logger.log(event.name, attributes);
  }
}
