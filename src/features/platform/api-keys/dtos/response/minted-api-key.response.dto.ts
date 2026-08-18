import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/** The one and only response that carries the plaintext token — returned exactly once, at mint.
 *  Nothing persists it; a caller that loses this response has lost the token permanently and must
 *  mint a new key. */
export class MintedApiKeyResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'API key identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ example: 'CI integration', description: 'Human-readable name for this key.' })
  name: string;

  @Expose()
  @ApiProperty({
    example: 'eo_pat_9f8c12ab34cd56ef',
    description:
      'The plaintext token. Shown exactly once — it cannot be retrieved again after this response.',
  })
  token: string;

  @Expose()
  @ApiProperty({
    example: 'eo_pat_9f8c12',
    description: 'Display prefix for identifying this key in a list.',
  })
  tokenPrefix: string;

  @Expose()
  @ApiProperty({
    example: '2026-12-31T00:00:00.000Z',
    description:
      'When this key stops working. Set to the request value if given, otherwise the default ' +
      'TTL (`apiKeys.defaultTtlDays` from config).',
    required: false,
  })
  expiresAt?: Date;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Key creation timestamp.' })
  createdAt: Date;
}
