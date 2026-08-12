import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Sse,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { qaApiExamples } from './api-examples/qa.api-examples';
import { StartQuestionRequestDto } from './dtos/request/start-question.request.dto';
import { AnswerResponseDto } from './dtos/response/answer.response.dto';
import { StartQuestionResponseDto } from './dtos/response/start-question.response.dto';
import { QaService } from './qa.service';

@Controller()
@ApiTags('qa')
@ApiBearerAuth()
export class QaController {
  constructor(private readonly qaService: QaService) {}

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
  // unthrottled, long-lived connection with an `ANSWER_STREAM_INTERVAL_MS` DB tick. Per-connection
  // and per-tenant stream caps are deliberately not implemented yet; owned by the observability/ops
  // phase, not this change.
  @Sse('answers/:id/events')
  @Version('1')
  @SkipThrottle()
  @ApiResponse(qaApiExamples.answerStream)
  streamAnswer(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Observable<MessageEvent> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return this.qaService.streamAnswer(id, user.userId, user.tenantId);
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
