import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SelectRequestDto {
  @ApiProperty({
    description: 'Comma-separated fields to include; `_id` is always returned.',
    example: 'name,status',
    required: false,
  })
  @IsOptional()
  @IsString()
  select?: string;
}
