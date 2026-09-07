import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';
import { LEDGER_STATES, type LedgerState } from '../../resolve-cell';

/** A measure is addressed by its slug, so the filter carries the slug grammar `Measure.slug`
 *  itself is validated against — an unmatchable filter value is a 400 rather than an empty page
 *  that reads like "this tenant has no such cells". */
export const MEASURE_SLUG_GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/;

export const LEDGER_CELL_SORT_FIELDS = ['entity', 'measure', 'period'] as const;
export type LedgerCellSortField = (typeof LEDGER_CELL_SORT_FIELDS)[number];

export class ListLedgerCellsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'Northgate Business Park',
    description: 'Entity name or a registered alias of one. Resolved to its canonical name first.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  entity?: string;

  @ApiProperty({
    example: 'cap_rate',
    description: 'Measure slug to filter by.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(MEASURE_SLUG_GRAMMAR)
  measure?: string;

  @ApiProperty({
    example: 'conflicted',
    enum: LEDGER_STATES,
    description: 'Resolved cell state to filter by.',
    required: false,
  })
  @IsOptional()
  @IsIn(LEDGER_STATES)
  state?: LedgerState;

  @ApiProperty({
    example: '2025-Q1',
    description: 'Period the cell covers. Absent means the undated period.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  period?: string;

  @ApiProperty({
    example: 'entity',
    enum: LEDGER_CELL_SORT_FIELDS,
    description: 'Field to sort by. Defaults to entity.',
    required: false,
  })
  @IsOptional()
  @IsIn(LEDGER_CELL_SORT_FIELDS)
  sort?: LedgerCellSortField;

  @ApiProperty({
    example: 'asc',
    enum: SORT_DIRECTIONS,
    description: 'Sort direction. Defaults to asc.',
    required: false,
  })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;
}
