import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { METRIC_ONTOLOGY } from './metric-ontology';

export interface MetricResult {
  readonly id: string;
  readonly label: string;
  readonly canonicalUnit: string;
}

/**
 * Read-only projection of the built-in METRIC_ONTOLOGY to the fields a caller needs to label a
 * metric id — nothing here authors, edits or removes a metric. Changing what METRIC_ONTOLOGY
 * defines is a code change to metric-ontology.ts, never a call through this service.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly logger: AppLogger) {
    this.logger.init(MetricsService.name);
  }

  list(): MetricResult[] {
    return METRIC_ONTOLOGY.map((metric) => ({
      id: metric.id,
      label: metric.label,
      canonicalUnit: metric.canonicalUnit,
    }));
  }
}
