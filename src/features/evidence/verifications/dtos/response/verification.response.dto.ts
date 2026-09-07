import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import type { ClaimAtoms } from '../../../qa/types/claim-atoms.type';
import { VerificationRequesterResponseDto } from './verification-requester.response.dto';
import { VerificationUsageResponseDto } from './verification-usage.response.dto';
import { VerifyClaimResultResponseDto } from './verify-claim-result.response.dto';

export class VerificationResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Verification identifier.' })
  id: string;

  @Expose()
  @Type(() => VerificationRequesterResponseDto)
  @ApiProperty({
    type: () => VerificationRequesterResponseDto,
    description: 'Who requested this verification run.',
  })
  requestedBy: VerificationRequesterResponseDto;

  @Expose()
  @ApiProperty({
    type: [String],
    description: 'Claim statements submitted for verification, in submission order.',
  })
  claims: string[];

  @Expose()
  @Type(() => VerifyClaimResultResponseDto)
  @ApiProperty({
    type: [VerifyClaimResultResponseDto],
    description: 'One result per submitted claim, in submission order.',
  })
  results: VerifyClaimResultResponseDto[];

  @Expose()
  @ApiProperty({
    description:
      'Fixed advisory accompanying every verification result — see VERIFY_CLAIMS_ADVISORY.',
  })
  advisory: string;

  @Expose()
  @ApiProperty({
    type: [String],
    description: 'Evidence chunk identifiers retrieved for this run.',
  })
  retrievedChunkIds: string[];

  @Expose()
  @ApiProperty({
    type: [Object],
    description: 'Atoms of the submitted claims, empty when no claim was decomposed.',
  })
  atoms: ClaimAtoms[];

  @Expose()
  @Type(() => VerificationUsageResponseDto)
  @ApiProperty({
    type: () => VerificationUsageResponseDto,
    description: 'Token and cost accounting summed across every model call in this run.',
  })
  usage: VerificationUsageResponseDto;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'Verification run creation timestamp.',
  })
  createdAt: Date;
}
