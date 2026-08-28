import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

// Sorts `canonicalNameNormalized`, not the raw `canonicalName`: the unique index this rides is on
// the normalized sibling, and the raw field is unindexed and byte-ordered, so 'Zeta' would sort
// before 'acme'. The response still renders the raw `canonicalName` — only the ordering key
// differs.
export const CANONICAL_ENTITY_SORT_FIELDS = ['canonicalNameNormalized', 'createdAt'] as const;
export type CanonicalEntitySortField = (typeof CANONICAL_ENTITY_SORT_FIELDS)[number];

export const DEFAULT_CANONICAL_ENTITY_SORT_FIELD: CanonicalEntitySortField =
  'canonicalNameNormalized';
export const DEFAULT_CANONICAL_ENTITY_SORT_DIRECTION: SortDirection = 'asc';

export class ListCanonicalEntitiesRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'canonicalNameNormalized',
    enum: CANONICAL_ENTITY_SORT_FIELDS,
    description: 'Field to sort by. Defaults to canonicalNameNormalized.',
    required: false,
  })
  @IsOptional()
  @IsIn(CANONICAL_ENTITY_SORT_FIELDS)
  sort?: CanonicalEntitySortField;

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
