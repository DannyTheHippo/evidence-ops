import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  CONFLICT_STATUSES,
  type ConflictStatus,
} from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

// `magnitude` deliberately excluded: it is stored, but each row carries its own required
// `magnitudeUnit`, so ordering by the bare number alone would rank a cap-rate spread against a
// dollar spread as if they were on the same scale.
export const CONFLICT_SORT_FIELDS = ['createdAt', 'status'] as const;
export type ConflictSortField = (typeof CONFLICT_SORT_FIELDS)[number];

export const DEFAULT_CONFLICT_SORT_FIELD: ConflictSortField = 'createdAt';
export const DEFAULT_CONFLICT_SORT_DIRECTION: SortDirection = 'desc';

export class ListConflictsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'open',
    enum: CONFLICT_STATUSES,
    description: 'Exact conflict status to filter by.',
    required: false,
  })
  @IsOptional()
  @IsIn(CONFLICT_STATUSES)
  status?: ConflictStatus;

  @ApiProperty({
    example: 'createdAt',
    enum: CONFLICT_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(CONFLICT_SORT_FIELDS)
  sort?: ConflictSortField;

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
