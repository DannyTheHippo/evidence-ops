import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UnauthorizedException,
  UseGuards,
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { metricPoliciesApiExamples } from './api-examples/metric-policies.api-examples';
import { UpsertMetricPolicyRequestDto } from './dtos/request/upsert-metric-policy.request.dto';
import { MetricPolicyResponseDto } from './dtos/response/metric-policy.response.dto';
import type { MetricId } from './metric-ontology';
import { MetricPoliciesService } from './metric-policies.service';

@Controller('metric-policies')
@ApiTags('metric-policies')
export class MetricPoliciesController {
  constructor(private readonly metricPoliciesService: MetricPoliciesService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(metricPoliciesApiExamples.list)
  async list(
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<MetricPolicyResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const docs = await this.metricPoliciesService.listForTenant(user.tenantId);

    return {
      docs: docs.map((doc) => toResponseDto(MetricPolicyResponseDto, doc)),
      count: docs.length,
    };
  }

  // Admin-only: an authored row changes how every conflict for this metric resolves tenant-wide,
  // the same register as reconfiguring a source (`sources.controller.ts`).
  @Put(':metric')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(metricPoliciesApiExamples.upserted)
  @ApiResponse(metricPoliciesApiExamples.unknownMetric)
  @ApiResponse(metricPoliciesApiExamples.invalidAuthorityOrder)
  @ApiResponse(metricPoliciesApiExamples.forbidden)
  async upsert(
    @Param('metric') metric: string,
    @Body() dto: UpsertMetricPolicyRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MetricPolicyResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MetricPolicyResponseDto,
      await this.metricPoliciesService.upsert(
        user.tenantId,
        metric as MetricId,
        {
          authorityOrder: dto.authorityOrder,
          stalenessWindowMs: dto.stalenessWindowMs,
        },
        user.userId,
      ),
    );
  }

  // Admin-only, same reasoning as `upsert`.
  @Delete(':metric')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(metricPoliciesApiExamples.reverted)
  @ApiResponse(metricPoliciesApiExamples.unknownMetric)
  @ApiResponse(metricPoliciesApiExamples.forbidden)
  async remove(
    @Param('metric') metric: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.metricPoliciesService.remove(user.tenantId, metric as MetricId, user.userId);
  }
}
