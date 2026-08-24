import {
  Controller,
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
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { metricPackPreviewApiExamples } from './api-examples/metric-pack-preview.api-examples';
import { ConflictsService } from './conflicts.service';
import { PackActivationPreviewResponseDto } from './dtos/response/pack-activation-preview.response.dto';

/**
 * `@Controller('metric-packs')` — same URL prefix `MetricPacksController` (`../facts/`) owns,
 * split into a second controller because the preview logic belongs on `ConflictsService`
 * (`ConflictsService.previewPackActivation`'s own doc comment) and `ConflictsModule` already
 * imports `FactsModule`, never the reverse — routing this handler through `MetricPacksController`
 * would need a cycle neither module has today. NestJS supports two controllers sharing a path
 * prefix across modules as long as no method+path pair collides; `POST /metric-packs/:packId/
 * versions/:version/preview` doesn't collide with anything `MetricPacksController` registers.
 */
@Controller('metric-packs')
@ApiTags('metric-packs')
export class MetricPackPreviewController {
  constructor(private readonly conflictsService: ConflictsService) {}

  // Admin-only, same register as `MetricPacksController.activate` — a preview reads the same
  // detection config an activation would commit to, and is gated at the same role for consistency
  // even though it persists nothing itself.
  @Post(':packId/versions/:version/preview')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(metricPackPreviewApiExamples.previewed)
  @ApiResponse(metricPackPreviewApiExamples.notFound)
  @ApiResponse(metricPackPreviewApiExamples.forbidden)
  async preview(
    @Param('packId') packId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<PackActivationPreviewResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      PackActivationPreviewResponseDto,
      await this.conflictsService.previewPackActivation(user.tenantId, packId, version),
    );
  }
}
