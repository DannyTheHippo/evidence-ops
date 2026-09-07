import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  VERIFICATION_REQUESTER_KINDS,
  type VerificationRequesterKind,
} from '../../../../../database/schemas/evidence/verification/verification.schema';

export class VerificationRequesterResponseDto {
  @Expose()
  @ApiProperty({
    example: 'pat',
    enum: VERIFICATION_REQUESTER_KINDS,
    description: 'Which kind of caller requested this verification run.',
  })
  kind: VerificationRequesterKind;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: 'Identifier of the requesting PAT or user.',
  })
  id: string;
}
