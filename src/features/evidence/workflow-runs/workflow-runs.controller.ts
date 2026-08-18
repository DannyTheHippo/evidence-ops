import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Sse,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { finalize } from 'rxjs';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { acquireStreamSlot } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { workflowRunsApiExamples } from './api-examples/workflow-runs.api-examples';
import { ListWorkflowRunsRequestDto } from './dtos/request/list-workflow-runs.request.dto';
import { WorkflowRunResponseDto } from './dtos/response/workflow-run.response.dto';
import { WorkflowRunsService } from './workflow-runs.service';

@Controller('workflow-runs')
@ApiTags('workflow-runs')
export class WorkflowRunsController {
  constructor(
    private readonly workflowRunsService: WorkflowRunsService,
    private readonly config: TypedConfigService,
  ) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(workflowRunsApiExamples.list)
  async list(
    @Query() query: ListWorkflowRunsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<WorkflowRunResponseDto>> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.workflowRunsService.listByWorkflowId(
      query,
      user.userId,
      user.tenantId,
    );

    return { docs: docs.map((doc) => toResponseDto(WorkflowRunResponseDto, doc)), count };
  }

  // MUST be declared above `@Get(':id')` — same-segment-count trap: a request to `:id/events` has
  // one more path segment than `:id` matches, so this specific pair never actually collides.
  // Documents' `events`-vs-`:id` pair does collide (both single-segment), so this is kept above
  // regardless, matching that route and future-proofing against this route ever changing shape.
  // No `@HttpCode` here: `@Sse()` owns the response status and streaming headers itself. Nest's
  // `SseStream` also always sends `Cache-Control` and `X-Accel-Buffering: no` on every SSE
  // response unconditionally (see `@nestjs/core`'s `sse-stream.js`), so no `@Header()` decorator is
  // needed to get those two headers onto the wire — one would be silently overridden anyway, since
  // Nest applies its own values after any caller-set ones.
  // `@SkipThrottle()` exempts this route from the global throttler entirely — an unbounded,
  // unthrottled, long-lived connection with a `WORKFLOW_RUN_STREAM_INTERVAL_MS` DB tick.
  // Per-tenant and per-user open-connection caps are enforced below (`acquireStreamSlot`, config'd
  // via `TypedConfigService.sse`), refusing with 429 once a tenant or user already has its
  // configured number of streams open. That bounds concurrency, not request rate — a burst of opens
  // that each close immediately never pushes concurrency past what a single lingering one would, so
  // this is not a throttling substitute; it exists to cap how much of the process's connection
  // budget one tenant or user can hold at once.
  @Sse(':id/events')
  @Version('1')
  @SkipThrottle()
  @ApiResponse(workflowRunsApiExamples.stream)
  @ApiResponse(workflowRunsApiExamples.streamConnectionLimitExceeded)
  streamRun(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Observable<MessageEvent> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const release = acquireStreamSlot(user.tenantId, user.userId, this.config.sse);

    return this.workflowRunsService
      .streamRun(id, user.userId, user.tenantId)
      .pipe(finalize(release));
  }

  @Get(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(workflowRunsApiExamples.detail)
  @ApiResponse(workflowRunsApiExamples.notFound)
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WorkflowRunResponseDto> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      WorkflowRunResponseDto,
      await this.workflowRunsService.findById(id, user.userId, user.tenantId),
    );
  }
}
