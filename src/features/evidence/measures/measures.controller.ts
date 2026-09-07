import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { measuresApiExamples } from './api-examples/measures.api-examples';
import { ListMeasuresRequestDto } from './dtos/request/list-measures.request.dto';
import { MeasureEditsRequestDto } from './dtos/request/measure-edits.request.dto';
import { RejectMeasureRequestDto } from './dtos/request/reject-measure.request.dto';
import { MeasureResponseDto } from './dtos/response/measure.response.dto';
import type { MeasureDocument } from '../../../database/schemas/evidence/measure/measure.schema';
import type { MeasureEdits } from './measures.service';
import { MeasuresService } from './measures.service';

/** Serializes one measure row. `toJSON()` emits `_id` and no schema here enables Mongoose's `id`
 *  virtual, so the identifier is mapped explicitly — without it `MeasureResponseDto.id` has no
 *  source value and `excludeExtraneousValues` drops the field from the payload silently. */
function toMeasureResponse(doc: MeasureDocument): MeasureResponseDto {
  return toResponseDto(MeasureResponseDto, { ...doc.toJSON(), id: doc._id.toString() });
}

/** Maps the request DTO's optional fields onto `MeasuresService`'s `MeasureEdits` shape — used by
 *  both `confirm` (edits merged over a proposed row) and `update` (edits merged over a confirmed
 *  one), which share the same request DTO. */
function toMeasureEdits(dto: MeasureEditsRequestDto): MeasureEdits {
  return {
    label: dto.label,
    aliases: dto.aliases,
    valueType: dto.valueType,
    canonicalUnit: dto.canonicalUnit,
    units: dto.units,
    toleranceKind: dto.toleranceKind,
    tolerance: dto.tolerance,
    authorityOrder: dto.authorityOrder,
    stalenessWindowMs: dto.stalenessWindowMs,
  };
}

@Controller('measures')
@ApiTags('measures')
export class MeasuresController {
  constructor(private readonly measuresService: MeasuresService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(measuresApiExamples.list)
  async list(
    @Query() query: ListMeasuresRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<MeasureResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.measuresService.listForTenant(user.tenantId, query);

    return { docs: docs.map(toMeasureResponse), count };
  }

  // Admin-only: confirming a proposed measure authorizes fact extraction to mint facts under it
  // tenant-wide, and triggers a synchronous rescan of every fact this measure already stamped.
  @Post(':id/confirm')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(measuresApiExamples.confirmed)
  @ApiResponse(measuresApiExamples.notFound)
  @ApiResponse(measuresApiExamples.notProposed)
  @ApiResponse(measuresApiExamples.invalidDefinition)
  @ApiResponse(measuresApiExamples.forbidden)
  async confirm(
    @Param('id') id: string,
    @Body() dto: MeasureEditsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MeasureResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toMeasureResponse(
      await this.measuresService.confirm(id, user.tenantId, toMeasureEdits(dto), user.userId),
    );
  }

  // Admin-only, same reasoning as confirm: rejecting a proposed measure decides tenant-wide that
  // no fact will ever be minted under it.
  @Post(':id/reject')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(measuresApiExamples.rejected)
  @ApiResponse(measuresApiExamples.notFound)
  @ApiResponse(measuresApiExamples.notProposed)
  @ApiResponse(measuresApiExamples.forbidden)
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectMeasureRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MeasureResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toMeasureResponse(
      await this.measuresService.reject(id, user.tenantId, dto.reason, user.userId),
    );
  }

  // Admin-only, same reasoning as confirm: editing a confirmed measure's definition changes how
  // every fact under it, past and future, is interpreted tenant-wide, and triggers the same
  // synchronous rescan.
  @Patch(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(measuresApiExamples.updated)
  @ApiResponse(measuresApiExamples.notFound)
  @ApiResponse(measuresApiExamples.notConfirmed)
  @ApiResponse(measuresApiExamples.invalidDefinition)
  @ApiResponse(measuresApiExamples.forbidden)
  async update(
    @Param('id') id: string,
    @Body() dto: MeasureEditsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MeasureResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toMeasureResponse(
      await this.measuresService.update(id, user.tenantId, toMeasureEdits(dto), user.userId),
    );
  }
}
