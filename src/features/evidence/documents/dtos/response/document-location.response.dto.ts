import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class DocumentLocationResponseDto {
  @Expose()
  @ApiProperty({
    example: 'rent-rolls/q3.xlsx',
    description:
      "Where this document's current-version bytes were seen — an upload filename or a connector relative path.",
  })
  path: string;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7ba',
    description: 'The connector this location was synced from, absent for a browser upload.',
    required: false,
  })
  sourceId?: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this location was first recorded.',
  })
  firstSeenAt: Date;
}
