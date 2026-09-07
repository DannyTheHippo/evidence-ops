import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  MEASURE_STATUSES,
  type MeasureStatus,
} from '../../../../../database/schemas/evidence/measure/measure.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const MEASURE_SORT_FIELDS = ['slug', 'status', 'createdAt'] as const;
export type MeasureSortField = (typeof MEASURE_SORT_FIELDS)[number];

export class ListMeasuresRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'proposed',
    enum: MEASURE_STATUSES,
    description: 'Exact measure status to filter by.',
    required: false,
  })
  @IsOptional()
  @IsIn(MEASURE_STATUSES)
  status?: MeasureStatus;

  @ApiProperty({
    example: 'slug',
    enum: MEASURE_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(MEASURE_SORT_FIELDS)
  sort?: MeasureSortField;

  @ApiProperty({
    example: 'desc',
    enum: SORT_DIRECTIONS,
    description: 'Sort direction. Defaults to desc.',
    required: false,
  })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;
}
