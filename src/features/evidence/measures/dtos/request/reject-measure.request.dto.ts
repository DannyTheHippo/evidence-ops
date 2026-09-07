import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectMeasureRequestDto {
  @ApiProperty({
    example: 'duplicate',
    description: 'Why this proposed measure was rejected.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
