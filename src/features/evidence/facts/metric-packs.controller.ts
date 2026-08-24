import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
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
import { metricPacksApiExamples } from './api-examples/metric-packs.api-examples';
import { CreateMetricPackVersionRequestDto } from './dtos/request/create-metric-pack-version.request.dto';
import { PublishMetricPackVersionRequestDto } from './dtos/request/publish-metric-pack-version.request.dto';
import { MetricPackResponseDto } from './dtos/response/metric-pack.response.dto';
import { MetricPacksService } from './metric-packs.service';

@Controller('metric-packs')
@ApiTags('metric-packs')
export class MetricPacksController {
  constructor(private readonly metricPacksService: MetricPacksService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(metricPacksApiExamples.list)
  async list(
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<MetricPackResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const docs = await this.metricPacksService.listForTenant(user.tenantId);

    return {
      docs: docs.map((doc) => toResponseDto(MetricPackResponseDto, doc)),
      count: docs.length,
    };
  }

  // Admin-only: an authored draft changes what every extraction and conflict scan reads once
  // activated — the same register as reconfiguring a metric policy (`metric-policies.controller.ts`).
  @Post(':packId/versions')
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(metricPacksApiExamples.created)
  @ApiResponse(metricPacksApiExamples.parentNotFound)
  @ApiResponse(metricPacksApiExamples.forbidden)
  async createVersion(
    @Param('packId') packId: string,
    @Body() dto: CreateMetricPackVersionRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MetricPackResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MetricPackResponseDto,
      await this.metricPacksService.createDraft(
        user.tenantId,
        packId,
        { label: dto.label, metrics: dto.metrics, parentVersion: dto.parentVersion },
        user.userId,
      ),
    );
  }

  // Admin-only, same reasoning as `createVersion`.
  @Post(':packId/versions/:version/publish')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(metricPacksApiExamples.published)
  @ApiResponse(metricPacksApiExamples.notFound)
  @ApiResponse(metricPacksApiExamples.notDraft)
  @ApiResponse(metricPacksApiExamples.unacknowledgedRemoval)
  @ApiResponse(metricPacksApiExamples.frozenArithmetic)
  @ApiResponse(metricPacksApiExamples.forbidden)
  async publish(
    @Param('packId') packId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: PublishMetricPackVersionRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MetricPackResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MetricPackResponseDto,
      await this.metricPacksService.publish(
        user.tenantId,
        packId,
        version,
        dto.acknowledgeRemovedMetricIds ?? [],
        user.userId,
      ),
    );
  }

  // Admin-only, same reasoning as `createVersion`.
  @Post(':packId/versions/:version/activate')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(metricPacksApiExamples.activated)
  @ApiResponse(metricPacksApiExamples.notFound)
  @ApiResponse(metricPacksApiExamples.notPublished)
  @ApiResponse(metricPacksApiExamples.forbidden)
  async activate(
    @Param('packId') packId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MetricPackResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MetricPackResponseDto,
      await this.metricPacksService.activate(user.tenantId, packId, version, user.userId),
    );
  }
}
