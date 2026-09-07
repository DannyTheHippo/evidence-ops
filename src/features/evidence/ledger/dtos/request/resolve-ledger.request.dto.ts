import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MEASURE_SLUG_GRAMMAR } from './list-ledger-cells.request.dto';

/** Addresses exactly one cell. `entity` and `measure` are required because a resolution is a
 *  statement about a specific `(entity, measure, period)` — there is no "resolve everything". */
export class ResolveLedgerRequestDto {
  @ApiProperty({
    example: 'Northgate Business Park',
    description: 'Entity name or a registered alias of one. Resolved to its canonical name first.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  entity: string;

  @ApiProperty({ example: 'cap_rate', description: 'Measure slug.' })
  @IsString()
  @Matches(MEASURE_SLUG_GRAMMAR)
  measure: string;

  @ApiProperty({
    example: '2025-Q1',
    description: 'Period the cell covers. Absent resolves the undated period.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  period?: string;
}
