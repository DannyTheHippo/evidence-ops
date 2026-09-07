import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import type { AnswerRunStatus } from '../../../../../database/schemas/evidence/answer/answer.schema';
import { ANSWER_RUN_STATUSES } from '../../../../../database/schemas/evidence/answer/answer.schema';
import type { AnswerContract, Citation } from '../../contracts/answer.contract';
import type { ClaimAtoms } from '../../types/claim-atoms.type';
import { AnswerUsageResponseDto } from './answer-usage.response.dto';
import { VerificationReportResponseDto } from './verification-report.response.dto';

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
      "The gate-verified outcome, present only once runStatus is 'completed'. For kind: " +
      "'answered', claims are the survivors of server-side grounding verification, never the " +
      "model's raw, unverified claim set. One of kind: 'answered' | 'insufficient_evidence' | " +
      "'conflicting_evidence'.",
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
    required: false,
    example: 12,
    description:
      "Number of evidence chunks retrieved for this run, present only once runStatus is 'completed'.",
  })
  retrievedChunkCount?: number;

  // Same conditional-presence rule as `outcome` above — the verification report is computed
  // alongside the outcome on completion, so a queued, running, or failed answer must not expose a
  // stale or absent value under this key.
  @Expose()
  @Type(() => VerificationReportResponseDto)
  @ApiProperty({
    required: false,
    type: () => VerificationReportResponseDto,
    description:
      "Server-computed claim verification summary, present only once runStatus is 'completed'.",
  })
  verificationReport?: VerificationReportResponseDto;

  @Expose()
  @ApiProperty({
    description: 'Citations backing the server-verified claims, flattened across all claims.',
    type: [Object],
  })
  citations: Citation[];

  @Expose()
  @ApiProperty({
    type: [Object],
    description: 'Atoms of the surviving claims, empty when no claim was decomposed.',
  })
  atoms: ClaimAtoms[];

  @Expose()
  @ApiProperty({
    type: [String],
    description: 'Conflict identifiers relevant to this answer, if any were detected.',
  })
  conflictIds: string[];

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Answer creation timestamp.' })
  createdAt: Date;

  @Expose()
  @ApiProperty({
    type: [String],
    description:
      'Cited document versions that currently carry withdrawnAt, resolved fresh on every read — ' +
      'never persisted alongside citations, so this can change between two reads of the same ' +
      'answer without the answer itself changing.',
  })
  withdrawnCitedDocVersionIds: string[];

  // Same conditional-presence rule as `outcome` above — usage is recorded on completion, so a
  // queued, running, or failed answer must not expose a stale or absent value under this key.
  @Expose()
  @Type(() => AnswerUsageResponseDto)
  @ApiProperty({
    required: false,
    type: () => AnswerUsageResponseDto,
    description:
      "Token and cost accounting for the QA synthesis call, present only once runStatus is 'completed'.",
  })
  usage?: AnswerUsageResponseDto;
}
