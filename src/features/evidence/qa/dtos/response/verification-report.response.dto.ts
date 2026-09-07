import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { AtomizationSummaryResponseDto } from './atomization-summary.response.dto';
import { DroppedClaimResponseDto } from './dropped-claim.response.dto';

export class VerificationReportResponseDto {
  @Expose()
  @ApiProperty({
    example: 3,
    description: 'Number of model-authored claims that survived server-side citation verification.',
  })
  verifiedClaimCount: number;

  @Expose()
  @ApiProperty({
    example: 4,
    description: 'Total number of model-authored claims before verification.',
  })
  totalClaimCount: number;

  @Expose()
  @Type(() => DroppedClaimResponseDto)
  @ApiProperty({
    type: [DroppedClaimResponseDto],
    description: 'Claims dropped during verification, with the reason each was dropped.',
  })
  droppedClaims: DroppedClaimResponseDto[];

  @Expose()
  @Type(() => AtomizationSummaryResponseDto)
  @ApiProperty({
    required: false,
    type: () => AtomizationSummaryResponseDto,
    description: 'Present only when at least one claim went through atom decomposition.',
  })
  atomization?: AtomizationSummaryResponseDto;
}
