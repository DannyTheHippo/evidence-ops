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
import type { Observable } from 'rxjs';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { workflowRunsApiExamples } from './api-examples/workflow-runs.api-examples';
import { ListWorkflowRunsRequestDto } from './dtos/request/list-workflow-runs.request.dto';
import { WorkflowRunResponseDto } from './dtos/response/workflow-run.response.dto';
import { WorkflowRunsService } from './workflow-runs.service';

@Controller('workflow-runs')
@ApiTags('workflow-runs')
export class WorkflowRunsController {
  constructor(private readonly workflowRunsService: WorkflowRunsService) {}

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
  // Per-connection and per-tenant stream caps are deliberately not implemented yet; owned by the
  // observability/ops phase, not this change.
  @Sse(':id/events')
  @Version('1')
  @SkipThrottle()
  @ApiResponse(workflowRunsApiExamples.stream)
  streamRun(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Observable<MessageEvent> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return this.workflowRunsService.streamRun(id, user.userId, user.tenantId);
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
