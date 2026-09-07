import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  VERIFICATION_REQUESTER_KINDS,
  type VerificationRequesterKind,
} from '../../../../../database/schemas/evidence/verification/verification.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const VERIFICATION_SORT_FIELDS = ['createdAt'] as const;
export type VerificationSortField = (typeof VERIFICATION_SORT_FIELDS)[number];

export const DEFAULT_VERIFICATION_SORT_FIELD: VerificationSortField = 'createdAt';
export const DEFAULT_VERIFICATION_SORT_DIRECTION: SortDirection = 'desc';

export class ListVerificationsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'pat',
    enum: VERIFICATION_REQUESTER_KINDS,
    description: 'Exact requester kind to filter by.',
    required: false,
  })
  @IsOptional()
  @IsIn(VERIFICATION_REQUESTER_KINDS)
  requestedByKind?: VerificationRequesterKind;

  @ApiProperty({
    example: 'createdAt',
    enum: VERIFICATION_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(VERIFICATION_SORT_FIELDS)
  sort?: VerificationSortField;

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
