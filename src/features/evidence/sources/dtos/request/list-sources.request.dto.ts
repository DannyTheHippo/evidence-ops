import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

// `fileCount` deliberately excluded: it is computed in `SourcesService.toResult` from
// `fileStates.length`, never stored on the document, so there is no column for the database to
// order by.
export const SOURCE_SORT_FIELDS = ['name', 'owner', 'lastSyncAt', 'createdAt'] as const;
export type SourceSortField = (typeof SOURCE_SORT_FIELDS)[number];

export const DEFAULT_SOURCE_SORT_FIELD: SourceSortField = 'name';
export const DEFAULT_SOURCE_SORT_DIRECTION: SortDirection = 'asc';

export class ListSourcesRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'failed',
    description:
      "Exact lastSyncStatus to filter by — currently only 'failed' is meaningful. Omit to list " +
      'every source regardless of sync outcome.',
    required: false,
  })
  @IsOptional()
  @IsString()
  lastSyncStatus?: string;

  @ApiProperty({
    example: false,
    description:
      "Filter to sources with this exact tracked value. R4 renders synced ('tracked: true') and " +
      "inventory-only ('tracked: false') sources as two separately-paged lists, so this cannot be " +
      'done by partitioning one fetched page client-side.',
    required: false,
  })
  @IsOptional()
  // This arrives as a query string, so it is a string on the wire — a bare `@IsBoolean()` would
  // 400 on the literal string 'false'. Same explicit-comparison shape as
  // `UploadDocumentRequestDto.requireApproval`, for the same reason: a bare `@Type(() => Boolean)`
  // would coerce the non-empty string 'false' to `true`.
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  tracked?: boolean;

  @ApiProperty({
    example: 'name',
    enum: SOURCE_SORT_FIELDS,
    description: 'Field to sort by. Defaults to name.',
    required: false,
  })
  @IsOptional()
  @IsIn(SOURCE_SORT_FIELDS)
  sort?: SourceSortField;

  @ApiProperty({
    example: 'asc',
    enum: SORT_DIRECTIONS,
    description: 'Sort direction. Defaults to asc.',
    required: false,
  })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;

  @ApiProperty({
    example: 'deal room',
    description:
      'Case-insensitive search over name, path and owner. Applies before pagination, so `count` ' +
      'reflects the filtered total rather than the full tenant list.',
    required: false,
  })
  @IsOptional()
  @IsString()
  q?: string;
}
