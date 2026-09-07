import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { MeasuresService } from '../measures/measures.service';

export interface MetricResult {
  readonly id: string;
  readonly label: string;
  readonly canonicalUnit: string;
}

/**
 * Read-only projection of the caller's tenant's confirmed measures to the fields a caller needs
 * to label a metric id — nothing here authors, edits or removes a measure. Authoring happens
 * through `POST /measures/:id/confirm` and `PATCH /measures/:id`, never through this service.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly measuresService: MeasuresService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(MetricsService.name);
  }

  async list(tenantId: string): Promise<MetricResult[]> {
    const definitions = await this.measuresService.listConfirmedDefinitions(tenantId);
    return definitions.map(({ id, label, canonicalUnit }) => ({ id, label, canonicalUnit }));
  }
}
