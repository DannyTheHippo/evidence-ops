import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { metricsApiExamples } from './api-examples/metrics.api-examples';
import { MetricResponseDto } from './dtos/response/metric.response.dto';
import { MetricsService } from './metrics.service';

/**
 * Read-only projection of the caller's tenant's confirmed measures — no POST/PATCH/DELETE handler
 * belongs here, now or later. Authoring a measure is `POST /measures/:id/confirm` or
 * `PATCH /measures/:id`, never a write through this API.
 *
 * No role gate beyond the global JwtAuthGuard: every authenticated member needs this to render a
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
  async list(@CurrentUser() user: AuthenticatedRequest['user']): Promise<MetricResponseDto[]> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const metrics = await this.metricsService.list(user.tenantId);
    return metrics.map((metric) => toResponseDto(MetricResponseDto, metric));
  }
}
