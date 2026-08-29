import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsMongoId, IsOptional } from 'class-validator';
import {
  CONFLICT_STATUSES,
  type ConflictStatus,
} from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import { MAX_PAGINATION_LIMIT } from '../../../../../shared/constants/pagination-defaults.constant';
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
    example: ['65f1c2e4a1b2c3d4e5f6a7b8'],
    description:
      'Conflict ids to resolve directly, comma-separated in a single querystring value or ' +
      'repeated (ids=a&ids=b) — both arrive at this handler the same way. When present, skip/limit ' +
      'are ignored and every matching conflict is returned, so a caller resolving a fixed batch ' +
      "(an answer's conflictIds, an approval's subject) never loses one to pagination. An id that " +
      'does not resolve — unknown or belonging to another tenant — is silently absent from the ' +
      'result rather than a 404, matching DocumentsService.lookupVersions.',
    type: [String],
    required: false,
  })
  @IsOptional()
  // Express parses a repeated `ids=a&ids=b` into an array already; only the comma-separated
  // single-value form needs splitting here.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray()
  @ArrayMaxSize(MAX_PAGINATION_LIMIT)
  @IsMongoId({ each: true })
  ids?: string[];

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
