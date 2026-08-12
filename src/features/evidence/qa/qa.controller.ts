import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
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
