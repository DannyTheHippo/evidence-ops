import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateApiKeyRequestDto {
  @ApiProperty({ example: 'CI integration', description: 'Human-readable name for this key.' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: '2026-12-31T00:00:00.000Z',
    description: 'When this key stops working. Omit for a key that never expires.',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
