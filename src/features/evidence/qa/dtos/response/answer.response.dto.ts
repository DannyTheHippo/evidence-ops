import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { AnswerRunStatus } from '../../../../../database/schemas/evidence/answer/answer.schema';
import { ANSWER_RUN_STATUSES } from '../../../../../database/schemas/evidence/answer/answer.schema';
import type { AnswerContract, Citation } from '../../contracts/answer.contract';

export class AnswerResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Answer identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'What is the cap rate for Northgate Business Park in Q1 2025?',
    description: 'The question this answer was requested for.',
  })
  questionText: string;

  @Expose()
  @ApiProperty({
    example: 'completed',
    enum: ANSWER_RUN_STATUSES,
    description: 'Workflow lifecycle status — separate from the answer outcome below.',
  })
  runStatus: AnswerRunStatus;

  // Only meaningful once `runStatus` is 'completed' (see `Answer.schema.ts`'s pre('validate')
  // hook) — omitted from the payload entirely for a queued, running, or failed answer rather
  // than presenting a stale or absent outcome as if it were final.
  @Expose()
  @ApiProperty({
    required: false,
    description:
      "The model-authored outcome, present only once runStatus is 'completed'. One of kind: 'answered' | 'insufficient_evidence' | 'conflicting_evidence'.",
    example: {
      kind: 'answered',
      claims: [{ statement: 'The cap rate is approximately 6.10%.', citations: [] }],
    },
  })
  outcome?: AnswerContract;

  @Expose()
  @ApiProperty({
    required: false,
    example: 0.75,
    description: 'Fraction of the model-authored claims that survived server-side verification.',
  })
  claimCoverage?: number;

  @Expose()
  @ApiProperty({
    description: 'Citations backing the server-verified claims, flattened across all claims.',
    type: [Object],
  })
  citations: Citation[];

  @Expose()
  @ApiProperty({
    type: [String],
    description: 'Conflict identifiers relevant to this answer, if any were detected.',
  })
  conflictIds: string[];

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Answer creation timestamp.' })
  createdAt: Date;
}
