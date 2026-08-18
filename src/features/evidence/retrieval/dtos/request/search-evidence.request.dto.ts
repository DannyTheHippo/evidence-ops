import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SearchEvidenceRequestDto {
  @ApiProperty({
    example: 'What is the cap rate for Northgate Business Park?',
    description: 'Search text run against the hybrid retrieval index.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  query: string;
}
