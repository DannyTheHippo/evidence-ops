import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/** Metadata only — never the token, never `tokenHash`. Mint is the sole response shape that
 *  carries the plaintext token (`MintedApiKeyResponseDto`); every other read of a key goes
 *  through this shape. */
export class ApiKeyResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'API key identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ example: 'CI integration', description: 'Human-readable name for this key.' })
  name: string;

  @Expose()
  @ApiProperty({
    example: 'eo_pat_9f8c12',
    description: 'Display prefix for identifying this key in a list.',
  })
  tokenPrefix: string;

  @Expose()
  @ApiProperty({
    example: '2026-12-31T00:00:00.000Z',
    description: 'When this key stops working. Absent means it never expires.',
    required: false,
  })
  expiresAt?: Date;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this key was revoked. Absent means the key is still active.',
    required: false,
  })
  revokedAt?: Date;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Key creation timestamp.' })
  createdAt: Date;
}
