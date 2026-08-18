import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { AnswerRunStatus } from '../../../../../database/schemas/evidence/answer/answer.schema';
import { ANSWER_RUN_STATUSES } from '../../../../../database/schemas/evidence/answer/answer.schema';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export class ListAnswersRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'completed',
    enum: ANSWER_RUN_STATUSES,
    description: 'Exact workflow run status to filter by.',
    required: false,
  })
  @IsOptional()
  @IsIn(ANSWER_RUN_STATUSES)
  runStatus?: AnswerRunStatus;
}
