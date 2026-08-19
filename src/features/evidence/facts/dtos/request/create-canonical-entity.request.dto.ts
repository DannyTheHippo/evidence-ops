import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCanonicalEntityRequestDto {
  @ApiProperty({
    example: 'Northgate Business Park',
    description: 'Canonical display name this row registers alternate spellings against.',
  })
  @IsString()
  @IsNotEmpty()
  canonicalName: string;

  @ApiProperty({
    example: ['Northgate Bus. Park'],
    description: 'Alternate spellings that should resolve to canonicalName.',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}
