import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CanonicalEntityResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Canonical entity identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'Northgate Business Park',
    description: 'Canonical display name this row registers alternate spellings against.',
  })
  canonicalName: string;

  @Expose()
  @ApiProperty({
    example: ['Northgate Bus. Park'],
    description: 'Alternate spellings that resolve to canonicalName.',
  })
  aliases: string[];

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this row was first authored.',
  })
  createdAt: Date;
}
