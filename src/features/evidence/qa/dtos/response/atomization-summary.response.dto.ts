import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class AtomizationSummaryResponseDto {
  @Expose()
  @ApiProperty({
    example: 3,
    description: 'Number of claims that were decomposed into atoms.',
  })
  decomposedClaimCount: number;

  @Expose()
  @ApiProperty({
    example: 0,
    description:
      'Number of claims whose atom decomposition was unavailable and fell back to coverage checking the whole statement.',
  })
  coverageFallbackCount: number;

  @Expose()
  @ApiProperty({
    example: 0,
    description:
      'Number of claims dropped because one or more of their atoms could not be grounded.',
  })
  atomDroppedClaimCount: number;

  @Expose()
  @ApiProperty({
    example: 0,
    description:
      'Number of claims dropped because the contradiction check found them incompatible with their own cited evidence.',
  })
  contradictionDroppedClaimCount: number;
}
