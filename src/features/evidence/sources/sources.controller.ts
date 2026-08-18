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
import { WorkflowRunResponseDto } from '../workflow-runs/dtos/response/workflow-run.response.dto';
import { sourcesApiExamples } from './api-examples/sources.api-examples';
import { CreateSourceRequestDto } from './dtos/request/create-source.request.dto';
import { ListSourcesRequestDto } from './dtos/request/list-sources.request.dto';
import { UpdateSourceRequestDto } from './dtos/request/update-source.request.dto';
import { ApplySourceClassDriftResponseDto } from './dtos/response/apply-source-class-drift.response.dto';
import { SourceClassDriftResponseDto } from './dtos/response/source-class-drift.response.dto';
import { SourceResponseDto } from './dtos/response/source.response.dto';
import { SourceWithFileStatesResponseDto } from './dtos/response/source-with-file-states.response.dto';
import { SourcesService } from './sources.service';

@Controller('sources')
@ApiTags('sources')
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  // Admin-only: this configures which external location feeds the tenant's evidence corpus for
  // every member, not a per-user contribution — unlike document upload, which only adds content a
  // Member could add anyway.
  @Post()
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(sourcesApiExamples.created)
  @ApiResponse(sourcesApiExamples.nameConflict)
  @ApiResponse(sourcesApiExamples.forbidden)
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
        connectivity: dto.connectivity,
        reachability: dto.reachability,
        owner: dto.owner,
        tracked: dto.tracked,
        sourceClass: dto.sourceClass,
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
    @Query() query: ListSourcesRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<SourceResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.sourcesService.list(query, user.userId, user.tenantId);

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

  // Admin-only, same reasoning as `create` above: reconfiguring a source (including disabling it)
  // silently changes corpus freshness for the whole tenant, with no trace anywhere a Member would see it.
  @Patch(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(sourcesApiExamples.found)
  @ApiResponse(sourcesApiExamples.notFound)
  @ApiResponse(sourcesApiExamples.forbidden)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSourceRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<SourceResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      SourceResponseDto,
      await this.sourcesService.update(
        id,
        {
          enabled: dto.enabled,
          connectivity: dto.connectivity,
          reachability: dto.reachability,
          owner: dto.owner,
          tracked: dto.tracked,
          sourceClass: dto.sourceClass,
        },
        user.userId,
        user.tenantId,
      ),
    );
  }

  // Deliberately left open to any role: unlike `create`/`update`, this operates a source an
  // admin already configured and enabled rather than changing that configuration, and the workflow
  // run it starts is deduplicated against an already-running sync — no more consequential than a
  // Member asking a question, which is also ungated.
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

  // Open to every role, same reasoning as `getById`: the drift itself is informational, not an
  // action — only `applyClassDrift` below changes anything.
  @Get(':id/class-drift')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(sourcesApiExamples.classDrift)
  @ApiResponse(sourcesApiExamples.notFound)
  async getClassDrift(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<SourceClassDriftResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      SourceClassDriftResponseDto,
      await this.sourcesService.getClassDriftReport(id, user.userId, user.tenantId),
    );
  }

  // Admin-only, same reasoning as `update`: this rewrites already-ingested evidence metadata
  // tenant-wide, not a per-user contribution.
  @Post(':id/class-drift/apply')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(sourcesApiExamples.classDriftApplied)
  @ApiResponse(sourcesApiExamples.notFound)
  @ApiResponse(sourcesApiExamples.forbidden)
  async applyClassDrift(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<ApplySourceClassDriftResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      ApplySourceClassDriftResponseDto,
      await this.sourcesService.applyClassDrift(id, user.userId, user.tenantId),
    );
  }
}
