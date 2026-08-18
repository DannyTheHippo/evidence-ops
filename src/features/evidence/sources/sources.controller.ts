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
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { WorkflowRunResponseDto } from '../workflow-runs/dtos/response/workflow-run.response.dto';
import { sourcesApiExamples } from './api-examples/sources.api-examples';
import { CreateSourceRequestDto } from './dtos/request/create-source.request.dto';
import { UpdateSourceEnabledRequestDto } from './dtos/request/update-source-enabled.request.dto';
import { SourceResponseDto } from './dtos/response/source.response.dto';
import { SourceWithFileStatesResponseDto } from './dtos/response/source-with-file-states.response.dto';
import { SourcesService } from './sources.service';

@Controller('sources')
@ApiTags('sources')
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Post()
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse(sourcesApiExamples.created)
  @ApiResponse(sourcesApiExamples.nameConflict)
  async create(
    @Body() dto: CreateSourceRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<SourceResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      SourceResponseDto,
      await this.sourcesService.create({
        name: dto.name,
        kind: dto.kind,
        path: dto.path,
        intervalMs: dto.intervalMs,
        enabled: dto.enabled,
        actorId: user.userId,
        tenantId: user.tenantId,
      }),
    );
  }

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(sourcesApiExamples.list)
  async list(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<SourceResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.sourcesService.list(pagination, user.userId, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(SourceResponseDto, doc)), count };
  }

  @Get(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(sourcesApiExamples.detail)
  @ApiResponse(sourcesApiExamples.notFound)
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<SourceWithFileStatesResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      SourceWithFileStatesResponseDto,
      await this.sourcesService.getById(id, user.userId, user.tenantId),
    );
  }

  @Patch(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(sourcesApiExamples.found)
  @ApiResponse(sourcesApiExamples.notFound)
  async setEnabled(
    @Param('id') id: string,
    @Body() dto: UpdateSourceEnabledRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<SourceResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      SourceResponseDto,
      await this.sourcesService.setEnabled(id, dto.enabled, user.userId, user.tenantId),
    );
  }

  @Post(':id/sync')
  @Version('1')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiResponse(sourcesApiExamples.syncAccepted)
  @ApiResponse(sourcesApiExamples.notFound)
  async requestSync(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WorkflowRunResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      WorkflowRunResponseDto,
      await this.sourcesService.requestSync(id, user.userId, user.tenantId),
    );
  }
}
