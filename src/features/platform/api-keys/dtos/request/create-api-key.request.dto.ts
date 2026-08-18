import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsNotEmpty, IsOptional, IsString, MaxDate } from 'class-validator';

/** Upper bound a caller may request explicitly — independent of `apiKeys.defaultTtlDays`, which
 *  only fills in when `expiresAt` is omitted. Decorators are evaluated at class-definition time,
 *  outside any DI context, so this cannot read `TypedConfigService`; it exists purely to stop a
 *  request from minting a key that outlives any reasonable rotation window. */
const MAX_EXPIRY_DAYS = 365;
const MAX_EXPIRY_MS = MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export class CreateApiKeyRequestDto {
  @ApiProperty({ example: 'CI integration', description: 'Human-readable name for this key.' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: '2026-12-31T00:00:00.000Z',
    description:
      'When this key stops working, at most one year out. Omit to use the default TTL ' +
      '(`apiKeys.defaultTtlDays` from config).',
    required: false,
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @MaxDate(() => new Date(Date.now() + MAX_EXPIRY_MS))
  expiresAt?: Date;
}
