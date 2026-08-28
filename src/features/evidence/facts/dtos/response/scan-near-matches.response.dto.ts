import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class ScanNearMatchesResponseDto {
  @Expose()
  @ApiProperty({
    example: 3,
    description:
      'Number of near-match proposals recorded by this scan. Each lands as a proposed ' +
      'harvestedAliases entry on the row it was attributed to, resolving nothing until confirmed.',
  })
  proposed: number;
}
