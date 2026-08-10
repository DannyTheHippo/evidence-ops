import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { AnswerRunStatus } from '../../../../../database/schemas/evidence/answer/answer.schema';
import { ANSWER_RUN_STATUSES } from '../../../../../database/schemas/evidence/answer/answer.schema';

export class StartQuestionResponseDto {
  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: "Answer identifier. Poll GET /answers/{id} for the run's status and outcome.",
  })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'queued',
    enum: ANSWER_RUN_STATUSES,
    description: 'Initial workflow run status — always queued at creation.',
  })
  runStatus: AnswerRunStatus;
}
