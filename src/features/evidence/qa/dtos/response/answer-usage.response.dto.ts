import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

// QA synthesis spend only — not embedding or extraction spend (see `Answer.usage`'s doc comment
// in `answer.schema.ts`). Field names stay scoped to that bound rather than implying a total.
export class AnswerUsageResponseDto {
  @Expose()
  @ApiProperty({ example: 1240, description: 'Prompt tokens for the synthesis call.' })
  promptTokens: number;

  @Expose()
  @ApiProperty({ example: 180, description: 'Completion tokens for the synthesis call.' })
  completionTokens: number;

  @Expose()
  @ApiProperty({ example: 0.0042, description: 'Synthesis call cost in USD.' })
  costUsd: number;
}
