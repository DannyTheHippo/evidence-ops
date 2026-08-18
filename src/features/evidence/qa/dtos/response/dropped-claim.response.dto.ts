import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class DroppedClaimResponseDto {
  @Expose()
  @ApiProperty({
    example: 'The cap rate is approximately 6.10%.',
    description: 'The model-authored claim statement that was dropped during verification.',
  })
  statement: string;

  @Expose()
  @ApiProperty({
    example: 'quote did not match the source chunk',
    description: 'Why the claim was dropped.',
  })
  reason: string;
}
