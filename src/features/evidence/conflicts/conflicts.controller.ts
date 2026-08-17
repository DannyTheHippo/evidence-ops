import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { WorkflowRunResponseDto } from '../workflow-runs/dtos/response/workflow-run.response.dto';
import { conflictsApiExamples } from './api-examples/conflicts.api-examples';
import { ConflictsService } from './conflicts.service';
import { RequestConflictResolutionRequestDto } from './dtos/request/request-conflict-resolution.request.dto';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';

@Controller('conflicts')
@ApiTags('conflicts')
@ApiBearerAuth()
export class ConflictsController {
  constructor(private readonly conflictsService: ConflictsService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(conflictsApiExamples.list)
  async list(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<ConflictResponseDto>> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.conflictsService.list(
      pagination,
      user.userId,
      user.tenantId,
    );

    return { docs: docs.map((doc) => toResponseDto(ConflictResponseDto, doc)), count };
  }

  @Post(':id/resolution-requests')
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse(conflictsApiExamples.resolutionRequested)
  @ApiResponse(conflictsApiExamples.notFound)
  @ApiResponse(conflictsApiExamples.invalidResolution)
  async requestResolution(
    @Param('id') id: string,
    @Body() dto: RequestConflictResolutionRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WorkflowRunResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      WorkflowRunResponseDto,
      await this.conflictsService.requestResolution({
        conflictId: id,
        winningFactId: dto.winningFactId,
        actorId: user.userId,
        requestedBy: user.email,
        origin: 'api',
        tenantId: user.tenantId,
      }),
    );
  }
}
