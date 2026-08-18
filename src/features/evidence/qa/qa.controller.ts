import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { acquireStreamSlot } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { qaApiExamples } from './api-examples/qa.api-examples';
import { ListAnswersRequestDto } from './dtos/request/list-answers.request.dto';
import { StartQuestionRequestDto } from './dtos/request/start-question.request.dto';
import { AnswerResponseDto } from './dtos/response/answer.response.dto';
import { StartQuestionResponseDto } from './dtos/response/start-question.response.dto';
import { QaService } from './qa.service';

@Controller()
@ApiTags('qa')
export class QaController {
  constructor(
    private readonly qaService: QaService,
    private readonly config: TypedConfigService,
  ) {}

  @Post('questions')
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse(qaApiExamples.started)
  @ApiResponse(qaApiExamples.validationError)
  async startQuestion(
    @Body() dto: StartQuestionRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<StartQuestionResponseDto> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      StartQuestionResponseDto,
      await this.qaService.startQuestion({
        questionText: dto.questionText,
        actorId: user.userId,
        role: user.role,
        tenantId: user.tenantId,
      }),
    );
  }

  // MUST be declared above `@Get('answers/:id')`. A request to `answers/:id/events` has one more
  // path segment than `answers/:id` matches, so this pair never actually collides on segment
  // count — unlike `DocumentsController`'s `events`-vs-`:id` pair, which does. Kept above it
  // anyway, matching the other two stream routes, so the ordering stays correct if this route's
  // shape ever changes to a bare sibling of `:id`. No `@HttpCode` here: `@Sse()` owns the response
  // status and streaming headers itself. No `@Header()` for Cache-Control/X-Accel-Buffering
  // either — `@nestjs/core`'s `SseStream` already sends both, unconditionally, on every SSE
  // response (see `WorkflowRunsController.streamRun`'s identical note for the source location).
  // `@SkipThrottle()` exempts this route from the global throttler entirely — an unbounded,
  // unthrottled, long-lived connection with an `ANSWER_STREAM_INTERVAL_MS` DB tick. Per-tenant and
  // per-user open-connection caps are enforced below (`acquireStreamSlot`, config'd via
  // `TypedConfigService.sse`), refusing with 429 once a tenant or user already has its configured
  // number of streams open. That bounds concurrency, not request rate — a burst of opens that each
  // close immediately never pushes concurrency past what a single lingering one would, so this is
  // not a throttling substitute; it exists to cap how much of the process's connection budget one
  // tenant or user can hold at once.
  @Sse('answers/:id/events')
  @Version('1')
  @SkipThrottle()
  @ApiResponse(qaApiExamples.answerStream)
  @ApiResponse(qaApiExamples.streamConnectionLimitExceeded)
  streamAnswer(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Observable<MessageEvent> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const release = acquireStreamSlot(user.tenantId, user.userId, this.config.sse);

    return this.qaService.streamAnswer(id, user.userId, user.tenantId).pipe(finalize(release));
  }

  // MUST be declared above `@Get('answers/:id')` — a bare `answers` segment count differs from
  // `answers/:id`, but keeping list-before-detail matches this controller's other ordering
  // comments and avoids relying on segment-count disambiguation being obvious to a future reader.
  @Get('answers')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(qaApiExamples.answersList)
  async listAnswers(
    @Query() query: ListAnswersRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<AnswerResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.qaService.listByTenant(query, user.userId, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(AnswerResponseDto, doc)), count };
  }

  @Get('answers/:id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(qaApiExamples.answerDetail)
  @ApiResponse(qaApiExamples.notFound)
  async getAnswerById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<AnswerResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      AnswerResponseDto,
      await this.qaService.getAnswerById(id, user.userId, user.tenantId),
    );
  }
}
