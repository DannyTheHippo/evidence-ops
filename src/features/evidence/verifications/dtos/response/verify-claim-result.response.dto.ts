import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { Citation } from '../../../qa/contracts/answer.contract';
import type { ClaimVerdict } from '../../../qa/contracts/verify-claims.contract';
import type { GroundingViolationKind } from '../../../qa/types/grounding-report.type';

export class VerifyClaimResultResponseDto {
  @Expose()
  @ApiProperty({
    example: 0,
    description: "Index of the verified claim within the run's submitted claims array.",
  })
  claimIndex: number;

  @Expose()
  @ApiProperty({
    example: 'grounded',
    enum: ['grounded', 'not_grounded', 'no_evidence_retrieved', 'conflicting_evidence'],
    description: 'Server-resolved verdict for this claim.',
  })
  verdict: ClaimVerdict;

  @Expose()
  @ApiProperty({
    required: false,
    example: 'atom-unsupported',
    description:
      'Mechanical reason the claim was degraded, present only on a non-grounded verdict.',
  })
  reasonCode?: GroundingViolationKind;

  @Expose()
  @ApiProperty({
    required: false,
    type: [Object],
    description: 'Server-resolved citations backing a grounded verdict.',
  })
  citations?: Citation[];
}
