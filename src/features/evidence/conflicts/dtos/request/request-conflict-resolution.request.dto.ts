import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

export class RequestConflictResolutionRequestDto {
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b9',
    description:
      "ExtractedFact id proposed as this conflict's correct value — the workflow gates this proposal behind a human, it does not choose it.",
  })
  @IsMongoId()
  winningFactId: string;
}
