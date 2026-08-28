import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** Carries the alias in the body rather than the path: a defined term may contain spaces, quotes
 *  and slashes, and a path segment carrying one is a percent-encoding failure waiting to happen. */
export class RevokeHarvestedAliasRequestDto {
  @ApiProperty({
    example: 'Property',
    description:
      'Harvested alias to revoke. Matched on the same normalized form resolution uses, so any ' +
      'spelling of the alias that resolves to it identifies it here.',
  })
  @IsString()
  @IsNotEmpty()
  alias: string;
}
