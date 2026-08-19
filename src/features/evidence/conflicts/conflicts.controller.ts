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
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { WorkflowRunResponseDto } from '../workflow-runs/dtos/response/workflow-run.response.dto';
import { conflictsApiExamples } from './api-examples/conflicts.api-examples';
import { ConflictsService } from './conflicts.service';
import { ListConflictsRequestDto } from './dtos/request/list-conflicts.request.dto';
import { RequestConflictResolutionRequestDto } from './dtos/request/request-conflict-resolution.request.dto';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';
import { ResolutionBacktestResponseDto } from './dtos/response/resolution-backtest.response.dto';
import { ResolutionBacktestService } from './resolution-backtest.service';

@Controller('conflicts')
@ApiTags('conflicts')
export class ConflictsController {
  constructor(
    private readonly conflictsService: ConflictsService,
    private readonly resolutionBacktestService: ResolutionBacktestService,
  ) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(conflictsApiExamples.list)
  async list(
    @Query() query: ListConflictsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<ConflictResponseDto>> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.conflictsService.list(query, user.userId, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(ConflictResponseDto, doc)), count };
  }

  @Get('resolution-backtest')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(conflictsApiExamples.resolutionBacktest)
  async resolutionBacktest(
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<ResolutionBacktestResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      ResolutionBacktestResponseDto,
      await this.resolutionBacktestService.run(user.tenantId),
    );
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
