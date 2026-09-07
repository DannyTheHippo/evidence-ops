import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

// Sum of every model call in the run (decomposition and contradiction checks included) — unlike
// `AnswerUsageResponseDto`, which scopes to the single QA synthesis call.
export class VerificationUsageResponseDto {
  @Expose()
  @ApiProperty({
    example: 640,
    description: 'Prompt tokens summed across every model call in this verification run.',
  })
  promptTokens: number;

  @Expose()
  @ApiProperty({
    example: 120,
    description: 'Completion tokens summed across every model call in this verification run.',
  })
  completionTokens: number;

  @Expose()
  @ApiProperty({
    example: 0.0031,
    description: 'Total cost in USD summed across every model call in this verification run.',
  })
  costUsd: number;
}
