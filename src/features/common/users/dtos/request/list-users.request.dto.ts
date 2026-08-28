import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const USER_SORT_FIELDS = ['createdAt', 'email', 'role'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export const DEFAULT_USER_SORT_FIELD: UserSortField = 'email';
export const DEFAULT_USER_SORT_DIRECTION: SortDirection = 'asc';

export class ListUsersRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'email',
    enum: USER_SORT_FIELDS,
    description: 'Field to sort by. Defaults to email.',
    required: false,
  })
  @IsOptional()
  @IsIn(USER_SORT_FIELDS)
  sort?: UserSortField;

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
