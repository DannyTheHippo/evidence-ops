import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';
import { MAX_PERIOD_KEY_LENGTH } from '../../../facts/derive-period';
import { MEASURE_SLUG_GRAMMAR } from './list-ledger-cells.request.dto';

/** The drill-down behind one cell, so it addresses a cell the same way `ResolveLedgerRequestDto`
 *  does. Unlike the cell and resolution views, this one returns facts at any `measureStatus`. */
export class ListLedgerFactsRequestDto extends PaginationRequestDto {
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
    description: 'Period the cell covers. Absent means the undated period.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PERIOD_KEY_LENGTH)
  period?: string;
}
