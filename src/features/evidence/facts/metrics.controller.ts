import { Controller, Get, HttpCode, HttpStatus, Version } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { metricsApiExamples } from './api-examples/metrics.api-examples';
import { MetricResponseDto } from './dtos/response/metric.response.dto';
import { MetricsService } from './metrics.service';

/**
 * Read-only: METRIC_ONTOLOGY has no operator-authoring surface, and this controller only ever
 * projects it. No POST/PATCH/DELETE handler belongs here, now or later — authoring the ontology
 * is a code change to metric-ontology.ts, not a runtime write through this API.
 *
 * No role gate beyond the global JwtAuthGuard: every authenticated user needs this to render a
 * metric id as a label, the same low-sensitivity read `CanonicalEntitiesController.list` grants to
 * any authenticated user rather than reserving for admins.
 */
@Controller('metrics')
@ApiTags('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(metricsApiExamples.list)
  list(): MetricResponseDto[] {
    return this.metricsService.list().map((metric) => toResponseDto(MetricResponseDto, metric));
  }
}
