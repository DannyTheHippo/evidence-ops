import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class MeResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Account identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ example: 'user@example.com', description: 'Account email address.' })
  email: string;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Account creation timestamp.' })
  createdAt: Date;
}
