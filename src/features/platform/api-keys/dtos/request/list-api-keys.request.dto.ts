import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const API_KEY_SORT_FIELDS = ['createdAt', 'name', 'lastUsedAt', 'expiresAt'] as const;
export type ApiKeySortField = (typeof API_KEY_SORT_FIELDS)[number];

export const DEFAULT_API_KEY_SORT_FIELD: ApiKeySortField = 'createdAt';
export const DEFAULT_API_KEY_SORT_DIRECTION: SortDirection = 'desc';

export class ListApiKeysRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'createdAt',
    enum: API_KEY_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(API_KEY_SORT_FIELDS)
  sort?: ApiKeySortField;

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
