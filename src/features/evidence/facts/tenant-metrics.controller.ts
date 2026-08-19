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
import { tenantMetricsApiExamples } from './api-examples/tenant-metrics.api-examples';
import { UpsertTenantMetricRequestDto } from './dtos/request/upsert-tenant-metric.request.dto';
import { TenantMetricResponseDto } from './dtos/response/tenant-metric.response.dto';
import { TenantMetricsService } from './tenant-metrics.service';

@Controller('tenant-metrics')
@ApiTags('tenant-metrics')
export class TenantMetricsController {
  constructor(private readonly tenantMetricsService: TenantMetricsService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(tenantMetricsApiExamples.list)
  async list(
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<TenantMetricResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const docs = await this.tenantMetricsService.listForTenant(user.tenantId);

    return {
      docs: docs.map((doc) => toResponseDto(TenantMetricResponseDto, doc)),
      count: docs.length,
    };
  }

  // Admin-only: an authored row changes what every user in the tenant sees a measure called, the
  // same register as reconfiguring a metric policy (`metric-policies.controller.ts`).
  @Put(':metricId')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(tenantMetricsApiExamples.upserted)
  @ApiResponse(tenantMetricsApiExamples.invalidMetricId)
  @ApiResponse(tenantMetricsApiExamples.forbidden)
  async upsert(
    @Param('metricId') metricId: string,
    @Body() dto: UpsertTenantMetricRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<TenantMetricResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      TenantMetricResponseDto,
      await this.tenantMetricsService.upsert(user.tenantId, metricId, dto.label),
    );
  }

  // Admin-only, same reasoning as `upsert`.
  @Delete(':metricId')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(tenantMetricsApiExamples.removed)
  @ApiResponse(tenantMetricsApiExamples.invalidMetricId)
  @ApiResponse(tenantMetricsApiExamples.forbidden)
  async remove(
    @Param('metricId') metricId: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.tenantMetricsService.remove(user.tenantId, metricId);
  }
}
