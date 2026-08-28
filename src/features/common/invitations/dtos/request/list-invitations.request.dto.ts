import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const INVITATION_SORT_FIELDS = ['createdAt', 'email', 'expiresAt', 'role'] as const;
export type InvitationSortField = (typeof INVITATION_SORT_FIELDS)[number];

export const DEFAULT_INVITATION_SORT_FIELD: InvitationSortField = 'createdAt';
export const DEFAULT_INVITATION_SORT_DIRECTION: SortDirection = 'desc';

export class ListInvitationsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'createdAt',
    enum: INVITATION_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(INVITATION_SORT_FIELDS)
  sort?: InvitationSortField;

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
