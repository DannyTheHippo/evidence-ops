import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/** One entity the ledger holds confirmed facts for, with how much of the record sits under it. */
export class LedgerEntityResponseDto {
  @Expose()
  @ApiProperty({ example: 'Northgate Business Park', description: 'Canonical entity name.' })
  entity: string;

  @Expose()
  @ApiProperty({
    example: 12,
    description: 'Confirmed-measure facts recorded against this entity.',
  })
  factCount: number;

  @Expose()
  @ApiProperty({
    example: 4,
    description: 'Distinct measures this entity has facts for.',
  })
  measureCount: number;
}
